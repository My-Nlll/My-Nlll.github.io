// Global searchConfig

document.addEventListener('DOMContentLoaded', () => {

  const input = document.querySelector('.search-input');
  const container = document.querySelector('.search-result-container');
  const popup = document.querySelector('.search-popup');
  const popupWindow = document.querySelector('.search-popup-window');
  const openButton = document.querySelector('.search-btn button');
  const closeButton = document.querySelector('.search-close-btn');
  const overlay = document.querySelector('.search-popup-overlay');
  let searchState = 'idle';
  let previouslyFocusedElement = null;

  const localSearch = new LocalSearch({
    path             : searchConfig.path,
    top_n_per_article: searchConfig.top_n_per_article,
    unescape         : searchConfig.unescape
  });

  function displayMessage(message = '') {
    const messageElement = document.createElement('div');
    messageElement.className = 'search-result-message';
    messageElement.textContent = message;
    container.replaceChildren(messageElement);
  }

  function displayLoadingMessage() {
    displayMessage('Loading search index...');
  }

  function displayLoadError() {
    const messageElement = document.createElement('div');
    messageElement.className = 'search-result-message search-result-error';
    messageElement.setAttribute('role', 'alert');

    const messageText = document.createElement('span');
    messageText.textContent = 'Search index could not be loaded.';

    const retryButton = document.createElement('button');
    retryButton.className = 'search-retry-button';
    retryButton.type = 'button';
    retryButton.textContent = 'Retry';

    messageElement.append(messageText, retryButton);
    container.replaceChildren(messageElement);
  }

  function fetchSearchData() {
    searchState = 'loading';
    displayLoadingMessage();
    // The runtime dispatches search:error; consume the rejected promise here
    // so a failed preload never becomes an unhandled browser rejection.
    return localSearch.fetchData().catch(() => null);
  }

  if (searchConfig.preload) {
    fetchSearchData();
  }

  function openSearchPopup(event) {
    event.preventDefault();
    previouslyFocusedElement = document.activeElement;
    popup.classList.add('search-activate');
    popup.setAttribute('aria-hidden', 'false');
    document.documentElement.classList.add('search-open');
    input.focus();
    if (!localSearch.isfetched) {
      fetchSearchData();
    }
  }

  function closeSearchPopup() {
    if (!popup.classList.contains('search-activate')) return;
    popup.classList.remove('search-activate');
    popup.setAttribute('aria-hidden', 'true');
    document.documentElement.classList.remove('search-open');
    // refresh search box
    input.value = '';
    displayMessage();

    const focusTarget = previouslyFocusedElement && previouslyFocusedElement.isConnected
      ? previouslyFocusedElement
      : openButton;
    previouslyFocusedElement = null;
    if (focusTarget) focusTarget.focus();
  }

  // open search box
  openButton.addEventListener('click', openSearchPopup);

  // close search box
  overlay.addEventListener('click', closeSearchPopup);
  closeButton.addEventListener('click', closeSearchPopup);

  document.addEventListener('keydown', event => {
    if (!popup.classList.contains('search-activate')) return;

    if (event.key === 'Escape') {
      event.preventDefault();
      closeSearchPopup();
      return;
    }

    if (event.key !== 'Tab') return;

    const focusableElements = [...popupWindow.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )];
    if (!focusableElements.length) return;

    const firstElement = focusableElements[0];
    const lastElement = focusableElements[focusableElements.length - 1];
    if (event.shiftKey && document.activeElement === firstElement) {
      event.preventDefault();
      lastElement.focus();
    } else if (!event.shiftKey && document.activeElement === lastElement) {
      event.preventDefault();
      firstElement.focus();
    }
  });

  function appendHighlightedText(parent, value, slice) {
    if (!slice) {
      parent.textContent = value;
      return;
    }

    let position = slice.start;
    for (const hit of slice.hits) {
      parent.append(document.createTextNode(value.substring(position, hit.position)));

      const mark = document.createElement('mark');
      mark.className = 'search-keyword';
      mark.textContent = value.substring(hit.position, hit.position + hit.length);
      parent.append(mark);
      position = hit.position + hit.length;
    }

    parent.append(document.createTextNode(value.substring(position, slice.end)));
  }

  function displayResultItems(resultItems) {
    const messageElement = document.createElement('div');
    messageElement.className = 'search-result-message';
    messageElement.textContent = `${resultItems.length} result(s) found`;

    const resultList = document.createElement('ul');
    resultList.className = 'search-result-list';

    resultItems.forEach(result => {
      const resultItem = document.createElement('li');
      const titleLink = document.createElement('a');
      titleLink.className = 'search-result-title';
      titleLink.href = result.url;
      appendHighlightedText(titleLink, result.title, result.titleSlice);
      resultItem.append(titleLink);

      result.contentSlices.forEach(slice => {
        const contentLink = document.createElement('a');
        contentLink.href = result.url;

        const contentText = document.createElement('p');
        contentText.className = 'search-result';
        appendHighlightedText(contentText, result.content, slice);
        contentText.append(document.createTextNode('...'));

        contentLink.append(contentText);
        resultItem.append(contentLink);
      });

      resultList.append(resultItem);
    });

    container.replaceChildren(messageElement, resultList);
  }

  function displaySearchResult() {
    if (!localSearch.isfetched) {
      if (searchState === 'loading') displayLoadingMessage();
      else if (searchState === 'error') displayLoadError();
      return;
    }
    const searchText = input.value.trim().toLowerCase();
    const keywords = searchText.split(/[-\s]+/);
    const resultItems = searchText.length > 0
      ? localSearch.getResultItems(keywords)
      : [];

    if (keywords.length === 1 && keywords[0] === '') {
      // no input
      displayMessage();
    } else if (resultItems.length === 0) {
      // no result
      displayMessage('No result found');
    } else {
      // display result(s)
      displayResultItems(resultItems);
    }

  }

  container.addEventListener('click', event => {
    if (event.target.closest('.search-retry-button')) fetchSearchData();
  });

  if (searchConfig.trigger === 'auto') {
    // whenever there is input, update search result
    input.addEventListener('input', displaySearchResult);
  } else {
    // update search result when press "enter"
    input.addEventListener('keypress', event => {
      if (event.key === 'Enter') {
        displaySearchResult();
      }
    })
  }
  window.addEventListener('search:loaded', () => {
    searchState = 'loaded';
    displaySearchResult();
  });
  window.addEventListener('search:error', () => {
    searchState = 'error';
    displayLoadError();
  });
});
  
