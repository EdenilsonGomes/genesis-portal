'use strict';
(function(){
  try {
    const saved = localStorage.getItem('genesis_theme');
    const theme = saved === 'dark' || saved === 'light' ? saved : 'light';
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  } catch {
    document.documentElement.dataset.theme = 'light';
  }
})();
