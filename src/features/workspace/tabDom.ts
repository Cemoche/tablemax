/**
 * DOM ids that tie the tab bar to the tab content: each tab is `tabDomId`, and the content
 * of the active tab is the tabpanel `tabPanelDomId` the active tab controls (one workspace
 * view is shown at a time).
 */
export const tabDomId = (wsId: string, tabId: string) => `tab-${wsId}-${tabId}`;
export const tabPanelDomId = (wsId: string) => `tabpanel-${wsId}`;
