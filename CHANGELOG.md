# Changelog

## [1.1.0] - 2026-01-20

### Added
- **Smart Alignment**: Text-based page matching for handling content reflow
- Support for comparing PDFs with different page counts
- Jaccard similarity algorithm for intelligent page matching
- `smartAlignment` option (default: true)
- `alignmentTolerance` option to control search range
- `similarityThreshold` option for minimum match quality
- Page mapping information in comparison results
- Similarity scores displayed in UI for matched pages

### Changed
- `compare()` method now handles different page counts gracefully
- Page comparison results now include `pageNumA` and `pageNumB` fields
- Enhanced error messages for page count mismatches

### Features
- Automatically finds best-matching pages based on text content
- Handles scenarios where text additions push content to new pages
- Displays page mappings (e.g., "Page 1 ↔ Page 2") in UI
- Shows content similarity percentage for cross-page comparisons

## [1.0.0] - 2026-01-19

### Added
- Initial release
- Embeddable PDFDiffViewer class for programmatic use
- Framework-agnostic vanilla JavaScript library
- Support for File, ArrayBuffer, and Uint8Array inputs
- Comprehensive API with configurable options
- Smart alignment algorithm for handling layout shifts
- Word-level text detection and highlighting
- Crop and mask regions support
- Standalone web application mode
- CLI support via `npx pdf-diff-viewer`
- Example implementation in `example/index.html`
- Full API documentation in README

### Features
- Client-side PDF comparison using PDF.js
- Zero system dependencies
- Privacy-focused (no server uploads)
- Visual diff overlays with configurable transparency
- Auto-detection of word boundaries
- Customizable rendering scale and tolerances
