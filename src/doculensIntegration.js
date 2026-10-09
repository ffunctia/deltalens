export const DOCULENS_DEFAULTS = {
  scale: 3.0,
  colorTolerance: 120,
  maxShift: 3,
  minHighlightArea: 60,
  minWordSize: 8,
  highlightAlpha: 0.32,
  labelA: 'Original document',
  labelB: 'Updated document',
  showPageNumbers: true,
  similarityThreshold: 0.3,
  alignmentTolerance: 2
};

export function summarizeComparison(results = {}) {
  const pageResults = results.pageResults || [];
  const totalDiffPixels = pageResults.reduce((sum, page) => sum + (page.diffPixels || 0), 0);
  const pageCount = pageResults.length || results.totalPages || 0;

  return {
    totalPages: pageCount,
    totalDiffPixels,
    diffPixels: totalDiffPixels,
    hasDifferences: totalDiffPixels > 0,
    pageResults: pageResults.map((page, index) => ({
      ...page,
      index,
      pageLabel: page.pageNumA === page.pageNumB ? `Page ${page.pageNumA}` : `Page ${page.pageNumA} ↔ ${page.pageNumB}`,
      similarity: page.similarity ?? 1
    }))
  };
}

export async function compareDocuments(fileA, fileB, options = {}) {
  if (!window.PDFDiffViewer) {
    throw new Error('PDFDiffViewer is not available. Load the PDF.js and PDFDiffViewer scripts before invoking compareDocuments().');
  }

  if (!fileA || !fileB) {
    throw new Error('Two files are required for a document comparison.');
  }

  const config = {
    ...DOCULENS_DEFAULTS,
    ...options,
    labelA: options.labelA || DOCULENS_DEFAULTS.labelA,
    labelB: options.labelB || DOCULENS_DEFAULTS.labelB
  };

  const viewer = new window.PDFDiffViewer(options.container || '#doculens-results', config);
  const results = await viewer.compare(fileA, fileB);
  const summary = summarizeComparison(results);

  return {
    viewer,
    results,
    summary,
    comparisonMethod: 'visual-pdf-diff'
  };
}

export function getComparisonStatus(summary) {
  if (!summary) {
    return 'No comparison data yet.';
  }

  if (summary.hasDifferences) {
    return `Detected ${summary.totalDiffPixels} differing pixels across ${summary.totalPages} page(s).`;
  }

  return `No visual differences detected across ${summary.totalPages} page(s).`;
}
