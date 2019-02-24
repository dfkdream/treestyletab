/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/
'use strict';

import {
  log as internalLogger,
  dumpTab,
  configs
} from '/common/common.js';

import * as Constants from '/common/constants.js';
import * as Tabs from '/common/tabs.js';
import * as TabsInternalOperation from '/common/tabs-internal-operation.js';
import * as TabsMove from '/common/tabs-move.js';
import * as TabsOpen from '/common/tabs-open.js';
import * as Tree from '/common/tree.js';

function log(...args) {
  internalLogger('background/handle-new-tabs', ...args);
}


// this should return false if the tab is / may be moved while processing
Tabs.onCreating.addListener((tab, info = {}) => {
  if (info.duplicatedInternally)
    return true;

  log('Tabs.onCreating ', tab.id, info);

  tab = tab.$TST.element;

  const possibleOpenerTab = (info.activeTab && info.activeTab.$TST.element) || Tabs.getActiveTab(tab.apiTab.windowId, { element: true });
  const opener = Tabs.getOpenerTab(tab);
  if (opener)
    Tabs.setAttribute(tab, 'data-original-opener-tab-id', opener.$TST.uniqueId.id);

  if (!opener) {
    if (!info.maybeOrphan &&
        possibleOpenerTab &&
        /* New tab opened with browser.tabs.insertAfterCurrent=true may have
           next tab. In this case the tab is expected to be placed next to the
           active tab aways, so we should skip all repositioning behavior.
           See also: https://github.com/piroor/treestyletab/issues/2054 */
        !Tabs.getNextTab(tab)) {
      if (Tabs.isNewTabCommandTab(tab)) {
        if (!info.positionedBySelf) {
          log('behave as a tab opened by new tab command');
          return handleNewTabFromActiveTab(tab, {
            activeTab:                 possibleOpenerTab,
            autoAttachBehavior:        configs.autoAttachOnNewTabCommand,
            inheritContextualIdentity: configs.inheritContextualIdentityToNewChildTab
          }).then(moved => !moved);
        }
        return false;
      }
      else if (possibleOpenerTab != tab) {
        tab.$TST.possibleOpenerTab = possibleOpenerTab.id;
      }
      tab.$TST.isNewTab = true;
    }
    log('behave as a tab opened with any URL');
    return true;
  }

  log(`opener: ${dumpTab(opener)}, positionedBySelf = ${info.positionedBySelf}`);
  if (Tabs.isPinned(opener) &&
      opener.parentNode == tab.parentNode) {
    if (configs.autoGroupNewTabsFromPinned) {
      return false;
    }
    if (configs.insertNewTabFromPinnedTabAt == Constants.kINSERT_END) {
      return TabsMove.moveTabAfter(tab, Tabs.getLastTab(tab.apiTab.windowId, { element: false }), {
        delayedMove: true,
        broadcast:   true
      }).then(moved => !moved);
    }
  }
  else if (!info.maybeOrphan && configs.autoAttach) {
    return Tree.behaveAutoAttachedTab(tab.apiTab, {
      baseTab:   opener && opener.apiTab,
      behavior:  configs.autoAttachOnOpenedWithOwner,
      dontMove:  info.positionedBySelf,
      broadcast: true
    }).then(moved => !moved);
  }
  return true;
});

async function handleNewTabFromActiveTab(tab, params = {}) {
  const activeTab = params.activeTab;
  log('handleNewTabFromActiveTab: activeTab = ', dumpTab(activeTab), params);
  const moved = await Tree.behaveAutoAttachedTab(tab.apiTab, {
    baseTab:   activeTab && activeTab.apiTab,
    behavior:  params.autoAttachBehavior,
    broadcast: true
  });
  const parent = Tabs.getParentTab(tab);
  if (!parent ||
      !params.inheritContextualIdentity ||
      tab.apiTab.cookieStoreId != 'firefox-default' ||
      tab.apiTab.cookieStoreId == parent.apiTab.cookieStoreId)
    return moved;
  const cookieStoreId = activeTab.apiTab.cookieStoreId;
  log('handleNewTabFromActiveTab: reopen with inherited contextual identity ', cookieStoreId);
  await TabsOpen.openNewTab({
    parent,
    insertBefore: tab,
    cookieStoreId
  });
  TabsInternalOperation.removeTab(tab);
  return moved;
}

Tabs.onCreated.addListener((tab, info = {}) => {
  if (!info.duplicated)
    return;
  const original = info.originalTab;
  log('duplicated ', tab.id, original && original.id);
  if (info.duplicatedInternally) {
    log('duplicated by internal operation');
    Tabs.addState(tab, Constants.kTAB_STATE_DUPLICATING, { broadcast: true });
  }
  else {
    Tree.behaveAutoAttachedTab(tab, {
      baseTab:   original,
      behavior:  configs.autoAttachOnDuplicated,
      dontMove:  info.positionedBySelf,
      broadcast: true
    });
  }
});

Tabs.onUpdated.addListener((tab, changeInfo) => {
  if ('openerTabId' in changeInfo &&
      configs.syncParentTabAndOpenerTab) {
    Tabs.waitUntilAllTabsAreCreated(tab.windowId).then(() => {
      const parent = Tabs.getOpenerTab(tab);
      if (!parent ||
          parent.windowId != tab.windowId ||
          parent == Tabs.getParentTab(tab))
        return;
      Tree.attachTabTo(tab, parent, {
        insertAt:    Constants.kINSERT_NEAREST,
        forceExpand: Tabs.isActive(tab),
        broadcast:   true
      });
    });
  }

  if ((changeInfo.url || changeInfo.status == 'complete') &&
      tab.$TST.isNewTab) {
    log('new tab ', tab.id);
    delete tab.$TST.isNewTab;
    const possibleOpenerTab = Tabs.getTabElementById(tab.$TST.possibleOpenerTab);
    delete tab.$TST.possibleOpenerTab;
    log('possibleOpenerTab ', possibleOpenerTab && possibleOpenerTab.id);
    const window = Tabs.trackedWindows.get(tab.windowId);
    const toBeGroupedTabs = window.openedNewTabs;
    log('toBeGroupedTabs ', toBeGroupedTabs);
    if (!Tabs.getParentTab(tab) &&
        possibleOpenerTab &&
        !toBeGroupedTabs.includes(tab.id)) {
      if (Tabs.isNewTabCommandTab(tab)) {
        log('behave as a tab opened by new tab command (delayed)');
        handleNewTabFromActiveTab(tab.$TST.element, {
          activeTab:                 possibleOpenerTab.$TST.element,
          autoAttachBehavior:        configs.autoAttachOnNewTabCommand,
          inheritContextualIdentity: configs.inheritContextualIdentityToNewChildTab
        });
      }
      else {
        const siteMatcher  = /^\w+:\/\/([^\/]+)(?:$|\/.*$)/;
        const openerTabSite = possibleOpenerTab.url.match(siteMatcher);
        const newTabSite    = tab.url.match(siteMatcher);
        if (openerTabSite && newTabSite && openerTabSite[1] == newTabSite[1]) {
          log('behave as a tab opened from same site (delayed)');
          handleNewTabFromActiveTab(tab.$TST.element, {
            activeTab:                 possibleOpenerTab.$TST.element,
            autoAttachBehavior:        configs.autoAttachSameSiteOrphan,
            inheritContextualIdentity: configs.inheritContextualIdentityToSameSiteOrphan
          });
        }
      }
    }
  }
});


Tabs.onAttached.addListener(async (tab, info = {}) => {
  if (!info.windowId ||
      !Tree.shouldApplyTreeBehavior(info))
    return;

  log('Tabs.onAttached ', tab.id, info);

  log('descendants of attached tab: ', info.descendants.map(tab => tab.id));
  const movedTabs = await Tree.moveTabs(info.descendants, {
    destinationWindowId: tab.windowId,
    insertAfter:         tab
  });
  log('moved descendants: ', movedTabs.map(dumpTab));
  for (const movedTab of movedTabs) {
    Tree.attachTabTo(movedTab, tab, {
      broadcast: true,
      dontMove:  true
    });
  }
});
