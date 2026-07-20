const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('fleet', {
  // config window
  launch: (cfg) => ipcRenderer.invoke('launch-fleet', cfg),
  pickFolder: () => ipcRenderer.invoke('pick-folder'),
  resizeWindow: (h, w) => ipcRenderer.send('resize-window', { h, w }),
  onLaunchError: (cb) => ipcRenderer.on('launch-error', (_e, d) => cb(d)),

  // grid window — multi-session (tabs)
  onAddSession: (cb) => ipcRenderer.on('add-session', (_e, d) => cb(d)),
  onAddPane: (cb) => ipcRenderer.on('add-pane', (_e, d) => cb(d)),
  newSession: () => ipcRenderer.send('new-session'),
  addGridWorker: ({ sid, name }) => ipcRenderer.invoke('add-grid-worker', { sid, name }),
  addProduct: ({ sid, name }) => ipcRenderer.invoke('add-product', { sid, name }),   // PRODUCTS mode: add one product (task-orchestrator pane) to a running session

  // Live Preview — dev-server manager (Visual Editor P1a). {sid, product, repo}
  previewStart: (a) => ipcRenderer.invoke('preview-start', a),   // -> {ok, url, port} | {ok:false, error}
  previewStop: (a) => ipcRenderer.invoke('preview-stop', a),     // -> {ok}
  previewStatus: (a) => ipcRenderer.invoke('preview-status', a), // -> {running, url, port, ready}

  // GitHub accounts (gh multi-account)
  ghAccounts: () => ipcRenderer.invoke('gh-accounts'),
  ghConnect: () => ipcRenderer.invoke('gh-connect'),
  ghConnectCancel: () => ipcRenderer.invoke('gh-connect-cancel'),
  ghDisconnect: (account) => ipcRenderer.invoke('gh-disconnect', account),
  onDeviceCode: (cb) => ipcRenderer.on('gh-device-code', (_e, code) => cb(code)),
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  copyText: (text) => ipcRenderer.invoke('clipboard-write', text),
  listAccountRepos: (account) => ipcRenderer.invoke('list-account-repos', account),
  setActiveSession: (sid) => ipcRenderer.send('active-session', sid),   // which tab is currently VISIBLE in this window (null = none) — gates notification suppression
  closeSession: (sid) => ipcRenderer.send('close-session', sid),
  closePane: (sid, id) => ipcRenderer.send('close-pane', { sid, id }),
  confirmClose: (kind, name) => ipcRenderer.invoke('confirm-close', { kind, name }),
  termReady: (info) => ipcRenderer.send('term-ready', info),     // {sid,id,cols,rows}
  termInput: (info) => ipcRenderer.send('term-input', info),     // {sid,id,data}
  termResize: (info) => ipcRenderer.send('term-resize', info),   // {sid,id,cols,rows}
  paneActivity: (info) => ipcRenderer.send('pane-activity', info),   // {sid,id,state,screen} — live state from the real screen
  onPtyData: (cb) => ipcRenderer.on('pty-data', (_e, d) => cb(d)),   // {sid,id,data}
  onPtyExit: (cb) => ipcRenderer.on('pty-exit', (_e, d) => cb(d)),   // {sid,id}
  onFleetError: (cb) => ipcRenderer.on('fleet-error', (_e, d) => cb(d)), // {sid,msg}
  onFocusPane: (cb) => ipcRenderer.on('focus-pane', (_e, d) => cb(d)),   // {sid,id} — overlay card click jumps to the pane
  onPaneState: (cb) => ipcRenderer.on('pane-state', (_e, d) => cb(d)),   // {sid,id,state} — drives the per-pane status dot
  answerPane: (sid, id, digit) => ipcRenderer.send('answer-pane', { sid, id, digit }),   // answer a queued permission prompt by option digit
  onCmdW: (cb) => ipcRenderer.on('cmd-w', () => cb()),   // ⌘W routed from the menu (pane/project-aware close)

  // system-wide permission OVERLAY (overlay.html) — always-on-top panel mirroring EVERY pending prompt across all sessions
  onPermQueue: (cb) => ipcRenderer.on('perm-queue', (_e, list) => cb(list)),   // full pending list [{sid,id,name,title,options}]
  focusPane: (sid, id) => ipcRenderer.send('overlay-focus', { sid, id }),      // click prompt body -> jump to that pane
  // (answerPane above is reused by the overlay to answer via the same 'answer-pane' path — single engine, no reinvention)

  // tab tear-off / re-dock (multi-window). A tab dragged off the bar -> main migrates the session between windows.
  onRemoveSession: (cb) => ipcRenderer.on('remove-session', (_e, d) => cb(d)),   // {sid} — this window lost a session to another window (dispose view, DON'T kill the PTYs)
  onTabbarHighlight: (cb) => ipcRenderer.on('tabbar-highlight', (_e, d) => cb(d)),  // {on} — show/hide the drop-target highlight on this window's tab bar
  tabDrop: (info) => ipcRenderer.invoke('tab-drop', info),       // {sid,screenX,screenY} -> {docked|torn|ignored}
  tabDragStart: (info) => ipcRenderer.send('tab-drag-start', info),   // {sid,title,color} — begin the follower chip
  tabDragMove: (info) => ipcRenderer.send('tab-drag-move', info),     // {screenX,screenY} — move follower + hit-test drop target (throttle ~16ms)
  tabDragEnd: () => ipcRenderer.send('tab-drag-end'),                 // drag returned into the bar / ended without a drop
  lastTabClosed: () => ipcRenderer.send('last-tab-closed'),          // this window's last tab was × closed

  // file manager / editor
  fsRoots: (sid) => ipcRenderer.invoke('fs-roots', sid),
  fsList: (sid, dir) => ipcRenderer.invoke('fs-list', { sid, dir }),
  fsRead: (sid, file) => ipcRenderer.invoke('fs-read', { sid, file }),
  fsWrite: (sid, file, content) => ipcRenderer.invoke('fs-write', { sid, file, content }),
  fsSearch: (sid, root, query) => ipcRenderer.invoke('fs-search', { sid, root, query }),

  // clipboard + drag-drop
  readClipboard: () => ipcRenderer.invoke('clipboard-read'),
  saveImageBytes: (bytes) => ipcRenderer.invoke('save-image-bytes', bytes),
  getPathForFile: (file) => { try { return webUtils.getPathForFile(file); } catch (_) { return (file && file.path) || null; } },
});
