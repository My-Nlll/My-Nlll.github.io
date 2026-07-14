function setMenuState(menuButton, menuList, expanded, isMobile) {
  const mobileExpanded = isMobile && expanded;
  menuList.classList.toggle('active', mobileExpanded);
  menuButton.setAttribute('aria-expanded', String(mobileExpanded));
  menuButton.textContent = mobileExpanded ? 'Close' : 'Menu';

  if (isMobile) {
    menuList.toggleAttribute('inert', !mobileExpanded);
    menuList.setAttribute('aria-hidden', String(!mobileExpanded));
  } else {
    menuList.removeAttribute('inert');
    menuList.removeAttribute('aria-hidden');
  }
}

function initializeMenu() {
  const menuButton = document.getElementById('menu-btn');
  const menuList = document.getElementById('menu-list');
  if (!menuButton || !menuList) return;
  const mobileViewport = window.matchMedia('(max-width: 688px)');

  const updateMenuState = expanded => {
    setMenuState(menuButton, menuList, expanded, mobileViewport.matches);
  };

  updateMenuState(false);

  menuButton.addEventListener('click', () => {
    const expanded = menuButton.getAttribute('aria-expanded') === 'true';
    updateMenuState(!expanded);
  });

  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || menuButton.getAttribute('aria-expanded') !== 'true') return;
    updateMenuState(false);
    menuButton.focus();
  });

  const handleViewportChange = () => updateMenuState(false);

  if (mobileViewport.addEventListener) {
    mobileViewport.addEventListener('change', handleViewportChange);
  } else {
    mobileViewport.addListener(handleViewportChange);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeMenu);
} else {
  initializeMenu();
}
