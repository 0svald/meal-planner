// Copy to config.js (git-ignored) to preset the values for local development.
// On GitHub Pages config.js does not exist: the same values are entered once in
// the app's settings screen (⚙︎) and kept in that browser's localStorage.
window.MENU_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec',
  clientId: 'CLIENT_ID.apps.googleusercontent.com'
}
