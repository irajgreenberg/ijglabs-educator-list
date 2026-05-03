// Theme toggle for admin pages — mirrors the public site's behaviour.
(function () {
  var STORE_KEY = 'ijg-educator-list-theme';
  var button = document.querySelector('.theme-toggle');
  function set(theme) {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORE_KEY, theme);
    if (button) button.textContent = theme === 'dark' ? 'light' : 'dark';
  }
  set(localStorage.getItem(STORE_KEY) || 'dark');
  if (button) button.addEventListener('click', function () {
    set(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  });
})();
