// Optional, for local development only: copy to config.js (git-ignored) to
// preset the API address. Normally nobody types it: the family opens the
// invitation link sent from Settings → Famiglia (the address travels in the
// link's #fragment), and the OAuth client id is asked to the script itself.
window.MENU_CONFIG = {
  endpoint: 'https://script.google.com/macros/s/DEPLOYMENT_ID/exec'
}
