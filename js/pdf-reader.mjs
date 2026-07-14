const readerElements = [...document.querySelectorAll('[data-pdf-reader]')];
const moduleScript = document.querySelector('script[data-pdf-reader-module]');
const vendorBase = new URL(
  moduleScript?.dataset.pdfjsBase || '../vendor/pdfjs/',
  moduleScript?.src || document.baseURI
);

function assetUrl(relativePath) {
  return new URL(relativePath, vendorBase).href;
}

function readNumber(element, name, fallback, minimum = 1) {
  const value = Number.parseFloat(element.dataset[name]);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

function readBoolean(element, name, fallback) {
  const value = element.dataset[name];
  if (value === undefined) return fallback;
  return value === 'true' || value === '1';
}

function parsePageSelection(specification, pageCount) {
  if (!specification || specification.toLowerCase() === 'all') {
    return Array.from({ length: pageCount }, (_, index) => index + 1);
  }

  const pages = new Set();
  for (const part of specification.split(',')) {
    const token = part.trim();
    if (!token) continue;

    const range = token.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Math.max(1, Math.min(Number(range[1]), Number(range[2])));
      const end = Math.min(pageCount, Math.max(Number(range[1]), Number(range[2])));
      for (let pageNumber = start; pageNumber <= end; pageNumber += 1) {
        pages.add(pageNumber);
      }
      continue;
    }

    const pageNumber = Number.parseInt(token, 10);
    if (Number.isInteger(pageNumber) && pageNumber >= 1 && pageNumber <= pageCount) {
      pages.add(pageNumber);
    }
  }

  return [...pages].sort((left, right) => left - right);
}

function friendlyError(error, pdfjsLib) {
  if (error instanceof pdfjsLib.PasswordException) {
    return 'This PDF is password-protected. Open the original PDF to enter its password.';
  }
  if (error instanceof pdfjsLib.InvalidPDFException) {
    return 'This file is not a valid or supported PDF.';
  }
  if (error instanceof pdfjsLib.MissingPDFException) {
    return 'The PDF file could not be found.';
  }
  if (error instanceof pdfjsLib.ResponseException) {
    return 'The PDF could not be downloaded. External files must allow cross-origin requests.';
  }
  return 'The PDF could not be displayed here. You can still open the original file.';
}

class ContinuousPdfReader {
  constructor(element, pdfjsLib, viewer) {
    this.element = element;
    this.container = element.querySelector('.pdf-document-pages');
    this.status = element.querySelector('.pdf-document-status');
    this.pdfjsLib = pdfjsLib;
    this.viewer = viewer;
    this.entries = new Map();
    this.visiblePages = new Set();
    this.renderedPages = new Map();
    this.currentPageNumber = 1;
    this.currentRotation = 0;
    this.lastContainerWidth = 0;
    this.resizeFrame = 0;
    this.destroyed = false;
    this.config = {
      source: new URL(element.dataset.pdfSrc, document.baseURI).href,
      renderDistance: readNumber(element, 'renderDistance', 1600),
      maxRenderedPages: Math.round(readNumber(element, 'maxRenderedPages', 8)),
      maxPixelRatio: readNumber(element, 'maxPixelRatio', 2, 0.5),
      startPage: Math.round(readNumber(element, 'startPage', 1)),
      pages: element.dataset.pages || 'all',
      textLayer: readBoolean(element, 'textLayer', true),
      annotationLayer: readBoolean(element, 'annotationLayer', true)
    };
  }

  async initialize() {
    this.loadingTask = this.pdfjsLib.getDocument({
      url: this.config.source,
      cMapUrl: assetUrl('cmaps/'),
      cMapPacked: true,
      standardFontDataUrl: assetUrl('standard_fonts/'),
      wasmUrl: assetUrl('wasm/'),
      iccUrl: assetUrl('iccs/'),
      enableXfa: true,
      enableScripting: false,
      isEvalSupported: false
    });

    this.loadingTask.onProgress = ({ loaded, total }) => {
      if (!total) return;
      const percentage = Math.min(100, Math.round((loaded / total) * 100));
      this.setStatus(`Loading PDF... ${percentage}%`);
    };

    this.pdfDocument = await this.loadingTask.promise;
    this.optionalContentConfigPromise = this.pdfDocument.getOptionalContentConfig();
    this.pageNumbers = parsePageSelection(this.config.pages, this.pdfDocument.numPages);

    if (!this.pageNumbers.length) {
      throw new Error(`The page selection "${this.config.pages}" does not contain a valid page.`);
    }

    this.setupLinkService();
    this.setupObservers();
    this.pagesReadyPromise = this.preparePages();
    await this.pagesReadyPromise;

    if (this.destroyed) return;
    const description = this.pageNumbers.length === this.pdfDocument.numPages
      ? `${this.pdfDocument.numPages} page${this.pdfDocument.numPages === 1 ? '' : 's'}`
      : `${this.pageNumbers.length} of ${this.pdfDocument.numPages} pages`;
    this.element.dataset.pdfState = 'ready';
    this.element.setAttribute('aria-busy', 'false');
    this.setStatus(description);

    if (this.config.startPage > 1) {
      const requestedPage = this.pageNumbers.includes(this.config.startPage)
        ? this.config.startPage
        : this.pageNumbers.find(pageNumber => pageNumber >= this.config.startPage);
      if (requestedPage) {
        requestAnimationFrame(() => this.scrollPageIntoView({ pageNumber: requestedPage }));
      }
    }
  }

  setupLinkService() {
    const { DownloadManager, EventBus, LinkTarget, PDFLinkService } = this.viewer;
    this.eventBus = new EventBus();
    this.downloadManager = new DownloadManager();
    this.linkService = new PDFLinkService({
      eventBus: this.eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
      ignoreDestinationZoom: true
    });

    const reader = this;
    this.viewerAdapter = {
      get currentPageNumber() {
        return reader.currentPageNumber;
      },
      set currentPageNumber(pageNumber) {
        reader.scrollPageIntoView({ pageNumber });
      },
      get pagesRotation() {
        return reader.currentRotation;
      },
      set pagesRotation(rotation) {
        reader.setRotation(rotation);
      },
      get isInPresentationMode() {
        return false;
      },
      get optionalContentConfigPromise() {
        return reader.optionalContentConfigPromise;
      },
      set optionalContentConfigPromise(value) {
        reader.optionalContentConfigPromise = value;
        reader.refreshVisiblePages();
      },
      pageLabelToPageNumber(label) {
        const pageNumber = Number.parseInt(label, 10);
        return Number.isInteger(pageNumber) ? pageNumber : null;
      },
      scrollPageIntoView(options) {
        reader.scrollPageIntoView(options);
      },
      nextPage() {
        reader.movePage(1);
      },
      previousPage() {
        reader.movePage(-1);
      }
    };

    this.linkService.setDocument(this.pdfDocument, this.config.source);
    this.linkService.setViewer(this.viewerAdapter);

    this.layerProperties = {
      annotationEditorUIManager: null,
      annotationStorage: this.pdfDocument.annotationStorage,
      downloadManager: this.downloadManager,
      enableScripting: false,
      fieldObjectsPromise: this.pdfDocument.getFieldObjects(),
      findController: null,
      hasJSActionsPromise: this.pdfDocument.hasJSActions(),
      linkService: this.linkService
    };
  }

  setupObservers() {
    this.intersectionObserver = new IntersectionObserver(entries => {
      for (const observed of entries) {
        const pageNumber = Number(observed.target.dataset.pageNumber);
        if (observed.isIntersecting) {
          this.visiblePages.add(pageNumber);
          this.currentPageNumber = pageNumber;
          this.renderPage(pageNumber);
        } else {
          this.visiblePages.delete(pageNumber);
        }
      }
      this.enforceRenderLimit();
    }, {
      root: null,
      rootMargin: `${this.config.renderDistance}px 0px`,
      threshold: 0
    });

    // ResizeObserver invokes its callback once when observation starts. Record
    // the current width first so that initial notification cannot cancel the
    // first page render without an actual size change.
    this.lastContainerWidth = Math.round(this.container.clientWidth);
    this.resizeObserver = new ResizeObserver(() => {
      cancelAnimationFrame(this.resizeFrame);
      this.resizeFrame = requestAnimationFrame(() => this.resizePages());
    });
    this.resizeObserver.observe(this.container);
  }

  async preparePages() {
    const batchSize = 8;
    for (let index = 0; index < this.pageNumbers.length; index += batchSize) {
      const batch = this.pageNumbers.slice(index, index + batchSize);
      const pages = await Promise.all(batch.map(pageNumber => this.pdfDocument.getPage(pageNumber)));

      if (this.destroyed) return;
      pages.forEach((pdfPage, pageIndex) => this.createPageEntry(batch[pageIndex], pdfPage));
      const prepared = Math.min(index + batch.length, this.pageNumbers.length);
      this.setStatus(`Preparing pages... ${prepared}/${this.pageNumbers.length}`);
    }
  }

  createPageEntry(pageNumber, pdfPage) {
    const baseViewport = pdfPage.getViewport({ scale: 1, rotation: this.currentRotation });
    const scale = this.scaleForViewport(baseViewport);
    const pageView = new this.viewer.PDFPageView({
      container: this.container,
      id: pageNumber,
      scale,
      defaultViewport: baseViewport,
      eventBus: this.eventBus,
      layerProperties: this.layerProperties,
      optionalContentConfigPromise: this.optionalContentConfigPromise,
      textLayerMode: this.config.textLayer ? 1 : 0,
      annotationMode: this.config.annotationLayer
        ? this.pdfjsLib.AnnotationMode.ENABLE
        : this.pdfjsLib.AnnotationMode.DISABLE,
      imageResourcesPath: assetUrl('web/images/'),
      maxCanvasPixels: this.maxCanvasPixels(baseViewport, scale),
      enableDetailCanvas: false,
      enableAutoLinking: this.config.annotationLayer
    });

    pageView.setPdfPage(pdfPage);
    pageView.div.id = `${this.element.id}-page-${pageNumber}`;
    pageView.div.classList.add('pdf-document-page--pending');
    pageView.div.setAttribute('aria-label', `Page ${pageNumber}`);

    const entry = {
      pageNumber,
      pdfPage,
      baseViewport,
      pageView,
      rendered: false,
      renderPromise: null,
      renderRevision: 0
    };
    this.entries.set(pageNumber, entry);
    this.intersectionObserver.observe(pageView.div);
  }

  scaleForViewport(viewport) {
    const containerWidth = Math.max(this.container.clientWidth, 1);
    const pdfToCssUnits = this.pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS;
    return containerWidth / (viewport.width * pdfToCssUnits);
  }

  maxCanvasPixels(viewport, scale) {
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.config.maxPixelRatio);
    const pdfToCssUnits = this.pdfjsLib.PixelsPerInch.PDF_TO_CSS_UNITS;
    const width = viewport.width * scale * pdfToCssUnits;
    const height = viewport.height * scale * pdfToCssUnits;
    return Math.ceil(width * height * pixelRatio * pixelRatio);
  }

  async renderPage(pageNumber) {
    const entry = this.entries.get(pageNumber);
    if (!entry || this.destroyed) return;

    this.touchPage(pageNumber);
    if (entry.rendered || entry.renderPromise) return entry.renderPromise;

    const renderRevision = entry.renderRevision;
    entry.renderPromise = entry.pageView.draw()
      .then(() => {
        const canvas = entry.pageView.canvas;
        const renderCompleted = entry.pageView.renderingState === this.viewer.RenderingStates.FINISHED;
        if (renderRevision !== entry.renderRevision || !renderCompleted || !canvas?.isConnected) {
          entry.rendered = false;
          return;
        }

        entry.rendered = true;
        entry.pageView.div.classList.remove('pdf-document-page--pending');
        entry.pageView.div.classList.add('pdf-document-page--rendered');
        this.touchPage(pageNumber);
        this.enforceRenderLimit();
      })
      .catch(error => {
        if (!(error instanceof this.pdfjsLib.RenderingCancelledException)) {
          console.error(`Unable to render PDF page ${pageNumber}:`, error);
          entry.pageView.div.classList.add('pdf-document-page--error');
        }
      })
      .finally(() => {
        entry.renderPromise = null;
        if (!entry.rendered && this.visiblePages.has(pageNumber) && !this.destroyed) {
          this.renderPage(pageNumber);
        }
      });

    return entry.renderPromise;
  }

  touchPage(pageNumber) {
    this.renderedPages.delete(pageNumber);
    this.renderedPages.set(pageNumber, performance.now());
  }

  enforceRenderLimit() {
    while (this.renderedPages.size > this.config.maxRenderedPages) {
      const candidate = [...this.renderedPages.keys()].find(pageNumber => !this.visiblePages.has(pageNumber));
      if (candidate === undefined) break;
      this.releasePage(candidate);
    }
  }

  releasePage(pageNumber) {
    const entry = this.entries.get(pageNumber);
    if (!entry) return;
    entry.renderRevision += 1;
    entry.pageView.reset();
    entry.rendered = false;
    entry.pageView.div.classList.remove('pdf-document-page--rendered');
    entry.pageView.div.classList.add('pdf-document-page--pending');
    this.renderedPages.delete(pageNumber);
  }

  resizePages() {
    const width = Math.round(this.container.clientWidth);
    if (!width || width === this.lastContainerWidth || this.destroyed) return;
    this.lastContainerWidth = width;

    for (const entry of this.entries.values()) {
      entry.renderRevision += 1;
      const scale = this.scaleForViewport(entry.baseViewport);
      entry.pageView.maxCanvasPixels = this.maxCanvasPixels(entry.baseViewport, scale);
      entry.pageView.update({ scale });
      entry.rendered = false;
      entry.pageView.div.classList.add('pdf-document-page--pending');
      entry.pageView.div.classList.remove('pdf-document-page--rendered');
    }

    this.renderedPages.clear();
    this.refreshVisiblePages();
  }

  refreshVisiblePages() {
    for (const pageNumber of this.visiblePages) {
      this.renderPage(pageNumber);
    }
  }

  async scrollPageIntoView({ pageNumber }) {
    if (this.pagesReadyPromise) await this.pagesReadyPromise;
    const entry = this.entries.get(pageNumber);
    if (!entry || this.destroyed) {
      this.setStatus(`Page ${pageNumber} is outside the selected page range.`);
      return;
    }

    await this.renderPage(pageNumber);
    entry.pageView.div.scrollIntoView({ behavior: 'smooth', block: 'start' });
    this.currentPageNumber = pageNumber;
  }

  movePage(offset) {
    const currentIndex = this.pageNumbers.indexOf(this.currentPageNumber);
    const targetIndex = Math.max(0, Math.min(this.pageNumbers.length - 1, currentIndex + offset));
    this.scrollPageIntoView({ pageNumber: this.pageNumbers[targetIndex] });
  }

  setRotation(rotation) {
    const normalized = ((rotation % 360) + 360) % 360;
    if (normalized === this.currentRotation) return;
    this.currentRotation = normalized;

    for (const entry of this.entries.values()) {
      entry.renderRevision += 1;
      entry.baseViewport = entry.pdfPage.getViewport({ scale: 1, rotation: normalized });
      entry.pageView.update({ rotation: normalized, scale: this.scaleForViewport(entry.baseViewport) });
      entry.rendered = false;
    }
    this.renderedPages.clear();
    this.refreshVisiblePages();
  }

  setStatus(message) {
    if (this.status) this.status.textContent = message;
  }

  showError(error) {
    console.error('Unable to initialize PDF reader:', error);
    this.element.dataset.pdfState = 'error';
    this.element.setAttribute('aria-busy', 'false');
    this.setStatus(friendlyError(error, this.pdfjsLib));

    if (!this.container.querySelector('.pdf-document-error')) {
      const errorBox = document.createElement('p');
      errorBox.className = 'pdf-document-error';
      errorBox.textContent = 'Inline reading is unavailable for this file.';
      this.container.append(errorBox);
    }
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.resizeFrame);
    this.intersectionObserver?.disconnect();
    this.resizeObserver?.disconnect();
    for (const entry of this.entries.values()) entry.pageView.destroy();
    this.loadingTask?.destroy();
  }
}

async function initializeReaders() {
  if (!readerElements.length) return;

  try {
    const pdfjsLib = await import(assetUrl('build/pdf.min.mjs'));
    globalThis.pdfjsLib = pdfjsLib;
    pdfjsLib.GlobalWorkerOptions.workerSrc = assetUrl('build/pdf.worker.min.mjs');
    const viewer = await import(assetUrl('web/pdf_viewer.mjs'));

    const readers = readerElements.map((element, index) => {
      if (!element.id) element.id = `pdf-document-${index + 1}`;
      return new ContinuousPdfReader(element, pdfjsLib, viewer);
    });

    await Promise.all(readers.map(reader => reader.initialize().catch(error => reader.showError(error))));
    window.addEventListener('pagehide', event => {
      if (!event.persisted) readers.forEach(reader => reader.destroy());
    }, { once: true });
  } catch (error) {
    console.error('Unable to load the local PDF.js runtime:', error);
    for (const element of readerElements) {
      element.dataset.pdfState = 'error';
      element.setAttribute('aria-busy', 'false');
      const status = element.querySelector('.pdf-document-status');
      if (status) status.textContent = 'The local PDF reader could not be loaded. Open the original file instead.';
    }
  }
}

initializeReaders();
