// Project-owned browser runtime based on hexo-generator-searchdb 1.5.0.
// The package remains responsible for generating the search index.

const STATE_PLAINTEXT = Symbol('plaintext');
const STATE_HTML = Symbol('html');
const STATE_COMMENT = Symbol('comment');

function striptags(html = '') {
  if (typeof html !== 'string' && !(html instanceof String)) {
    return '';
  }

  let state = STATE_PLAINTEXT;
  let tagBuffer = '';
  let depth = 0;
  let inQuoteChar = '';
  let output = '';

  for (const char of html) {
    if (state === STATE_PLAINTEXT) {
      if (char === '<') {
        state = STATE_HTML;
        tagBuffer += char;
      } else {
        output += char;
      }
    } else if (state === STATE_HTML) {
      switch (char) {
        case '<':
          if (!inQuoteChar) depth++;
          break;
        case '>':
          if (inQuoteChar) break;
          if (depth) {
            depth--;
            break;
          }
          inQuoteChar = '';
          state = STATE_PLAINTEXT;
          tagBuffer = '';
          break;
        case '"':
        case "'":
          if (char === inQuoteChar) {
            inQuoteChar = '';
          } else {
            inQuoteChar = inQuoteChar || char;
          }
          tagBuffer += char;
          break;
        case '-':
          if (tagBuffer === '<!-') state = STATE_COMMENT;
          tagBuffer += char;
          break;
        case ' ':
        case '\n':
          if (tagBuffer === '<') {
            state = STATE_PLAINTEXT;
            output += '< ';
            tagBuffer = '';
          } else {
            tagBuffer += char;
          }
          break;
        default:
          tagBuffer += char;
      }
    } else if (state === STATE_COMMENT) {
      if (char === '>') {
        if (tagBuffer.slice(-2) === '--') state = STATE_PLAINTEXT;
        tagBuffer = '';
      } else {
        tagBuffer += char;
      }
    }
  }

  return output;
}

class LocalSearch {
  constructor({ path = '', unescape = false, top_n_per_article = 1 }) {
    this.path = path;
    this.unescape = unescape;
    this.top_n_per_article = top_n_per_article;
    this.isfetched = false;
    this.datas = null;
    this.fetchingPromise = null;
  }

  getIndexByWord(words, text, caseSensitive = false) {
    const index = [];
    const included = new Set();

    if (!caseSensitive) text = text.toLowerCase();
    words.forEach(word => {
      if (this.unescape) {
        const div = document.createElement('div');
        div.innerText = word;
        word = div.innerHTML;
      }
      const wordLen = word.length;
      if (wordLen === 0) return;
      let startPosition = 0;
      let position = -1;
      if (!caseSensitive) word = word.toLowerCase();
      while ((position = text.indexOf(word, startPosition)) > -1) {
        index.push({ position, word });
        included.add(word);
        startPosition = position + wordLen;
      }
    });

    index.sort((left, right) => {
      if (left.position !== right.position) return left.position - right.position;
      return right.word.length - left.word.length;
    });
    return [index, included];
  }

  mergeIntoSlice(start, end, index) {
    let item = index[0];
    let { position, word } = item;
    const hits = [];
    const count = new Set();

    while (position + word.length <= end && index.length !== 0) {
      count.add(word);
      hits.push({ position, length: word.length });
      const wordEnd = position + word.length;
      index.shift();
      while (index.length !== 0) {
        item = index[0];
        position = item.position;
        word = item.word;
        if (wordEnd > position) index.shift();
        else break;
      }
    }

    return { hits, start, end, count: count.size };
  }

  getResultItems(keywords) {
    const resultItems = [];
    this.datas.forEach(({ title, content, url }) => {
      const [indexOfTitle, keysOfTitle] = this.getIndexByWord(keywords, title);
      const [indexOfContent, keysOfContent] = this.getIndexByWord(keywords, content);
      const includedCount = new Set([...keysOfTitle, ...keysOfContent]).size;
      const hitCount = indexOfTitle.length + indexOfContent.length;
      if (hitCount === 0) return;

      const slicesOfTitle = [];
      if (indexOfTitle.length !== 0) {
        slicesOfTitle.push(this.mergeIntoSlice(0, title.length, indexOfTitle));
      }

      let slicesOfContent = [];
      while (indexOfContent.length !== 0) {
        const { position } = indexOfContent[0];
        const start = Math.max(0, position - 20);
        const end = Math.min(content.length, position + 80);
        slicesOfContent.push(this.mergeIntoSlice(start, end, indexOfContent));
      }

      slicesOfContent.sort((left, right) => {
        if (left.count !== right.count) return right.count - left.count;
        if (left.hits.length !== right.hits.length) return right.hits.length - left.hits.length;
        return left.start - right.start;
      });

      const upperBound = parseInt(this.top_n_per_article, 10);
      if (upperBound >= 0) slicesOfContent = slicesOfContent.slice(0, upperBound);

      url = new URL(url, location.origin);
      url.searchParams.delete('highlight');

      resultItems.push({
        id: resultItems.length,
        hitCount,
        includedCount,
        url: url.href,
        title,
        titleSlice: slicesOfTitle[0] || null,
        content,
        contentSlices: slicesOfContent
      });
    });
    return resultItems;
  }

  parseData(rawData) {
    if (this.path.toLowerCase().endsWith('json')) {
      const data = JSON.parse(rawData);
      if (!Array.isArray(data)) throw new Error('The search index is not a JSON array.');
      return data;
    }

    const documentNode = new DOMParser().parseFromString(rawData, 'text/xml');
    if (documentNode.querySelector('parsererror')) {
      throw new Error('The search index is not valid XML.');
    }

    return [...documentNode.querySelectorAll('entry')].map(element => {
      const title = element.querySelector('title');
      const content = element.querySelector('content');
      const url = element.querySelector('url');
      if (!title || !url) throw new Error('The search index contains an incomplete entry.');
      return {
        title: title.textContent,
        content: content ? content.textContent : '',
        url: url.textContent
      };
    });
  }

  fetchData() {
    if (this.isfetched) return Promise.resolve(this.datas);
    if (this.fetchingPromise) return this.fetchingPromise;

    this.fetchingPromise = fetch(this.path, { credentials: 'same-origin' })
      .then(response => {
        if (!response.ok) {
          throw new Error(`Unable to load the search index (HTTP ${response.status}).`);
        }
        return response.text();
      })
      .then(rawData => {
        const isJsonIndex = this.path.toLowerCase().endsWith('json');
        this.datas = this.parseData(rawData)
          .filter(data => data.title)
          .map(data => ({
            title: data.title.trim(),
            content: data.content
              ? (isJsonIndex ? data.content.trim() : striptags(data.content.trim()))
              : '',
            url: decodeURIComponent(data.url).replace(/\/{2,}/g, '/')
          }));
        this.isfetched = true;
        window.dispatchEvent(new CustomEvent('search:loaded', {
          detail: { itemCount: this.datas.length }
        }));
        return this.datas;
      })
      .catch(error => {
        this.isfetched = false;
        this.datas = null;
        window.dispatchEvent(new CustomEvent('search:error', { detail: { error } }));
        throw error;
      })
      .finally(() => {
        this.fetchingPromise = null;
      });

    return this.fetchingPromise;
  }

}
