angular.module("pdfDiffApp", [])
    .controller("MainCtrl", function ($scope) {

        pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

        const SCALE = 3.0; // ~300 DPI
        const MAX_SHIFT = 3; // pixel search radius for alignment
        const DILATION_RADIUS = 0; // set >0 to expand highlights around small diffs
        const COLOR_TOLERANCE = 120; // sum of channel deltas required to call a pixel different
        const MIN_HIGHLIGHT_AREA = 60; // pixels - minimum area to highlight
        const MIN_WORD_SIZE = 8; // pixels - minimum word box width/height to highlight
        const HIGHLIGHT_ALPHA = 0.32;
        async function renderPageToCanvas(pdf, pageNum, canvas) {
            const page = await pdf.getPage(pageNum);
            const viewport = page.getViewport({ scale: SCALE });

            // ❗ Ensure exact same dimensions every time
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);

            const ctx = canvas.getContext("2d");

            // ❗ Clear previous page completely (prevents overlap artifacts)
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.imageSmoothingEnabled = false;

            await page.render({
                canvasContext: ctx,
                viewport
            }).promise;

            const words = await extractWordBoxes(page, viewport);
            return { words };
        }

        async function extractWordBoxes(page, viewport) {
            const textContent = await page.getTextContent({ normalizeWhitespace: true });
            const boxes = [];

            textContent.items.forEach((item) => {
                const text = (item.str || "").trim();
                if (!text) {
                    return;
                }

                const transform = pdfjsLib.Util.transform(viewport.transform, item.transform);
                const x = transform[4];
                const y = transform[5];

                const width = (item.width || 0) * viewport.scale;
                const glyphHeight = Math.hypot(transform[2], transform[3]);
                const height = glyphHeight || ((item.height || 0) * viewport.scale);

                if (!width || !height) {
                    return;
                }

                const charWidth = width / text.length;
                if (!isFinite(charWidth) || charWidth <= 0) {
                    return;
                }

                const baseY = y - height;
                let cursorX = x;

                text.split(/(\s+)/).forEach((segment) => {
                    if (!segment) {
                        return;
                    }

                    const segmentWidth = charWidth * segment.length;
                    if (!segment.trim()) {
                        cursorX += segmentWidth;
                        return;
                    }

                    const paddingX = charWidth * 0.18;
                    const paddingY = height * 0.15;
                    const box = padBox({
                        x: cursorX,
                        y: baseY,
                        width: segmentWidth,
                        height
                    }, paddingX, paddingY);

                    boxes.push(box);
                    cursorX += segmentWidth;
                });
            });

            return boxes;
        }

        // Pad a rendered canvas so both sides share identical dimensions (avoids overlap/misalignment).
        function padCanvas(srcCanvas, targetWidth, targetHeight) {
            if (srcCanvas.width === targetWidth && srcCanvas.height === targetHeight) {
                return srcCanvas;
            }

            const padded = document.createElement("canvas");
            padded.width = targetWidth;
            padded.height = targetHeight;

            const ctx = padded.getContext("2d");
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, targetWidth, targetHeight);
            ctx.drawImage(srcCanvas, 0, 0);
            return padded;
        }

        // Shift a canvas by (dx, dy) on a white background and return ImageData.
        function getShiftedImageData(srcCanvas, width, height, dx, dy) {
            const temp = document.createElement("canvas");
            temp.width = width;
            temp.height = height;
            const ctx = temp.getContext("2d");
            ctx.fillStyle = "white";
            ctx.fillRect(0, 0, width, height);
            ctx.drawImage(srcCanvas, dx, dy);
            return ctx.getImageData(0, 0, width, height);
        }

        function pixelDelta(dataA, dataB, index) {
            return Math.abs(dataA[index] - dataB[index]) +
                Math.abs(dataA[index + 1] - dataB[index + 1]) +
                Math.abs(dataA[index + 2] - dataB[index + 2]);
        }

        // Count different pixels between two images given a tolerance.
        function countDiffPixels(imgA, imgB, tolerance) {
            const dataA = imgA.data;
            const dataB = imgB.data;
            let diff = 0;
            for (let i = 0; i < dataA.length; i += 4) {
                if (pixelDelta(dataA, dataB, i) > tolerance) {
                    diff++;
                }
            }
            return diff;
        }

        // Search small translations to find the lowest diff count (helps with minor reflows).
        function findBestOffset(imgA, paddedB, width, height, tolerance) {
            let best = { diff: Infinity, dx: 0, dy: 0 };
            for (let dy = -MAX_SHIFT; dy <= MAX_SHIFT; dy++) {
                for (let dx = -MAX_SHIFT; dx <= MAX_SHIFT; dx++) {
                    const shiftedB = getShiftedImageData(paddedB, width, height, dx, dy);
                    const diffCount = countDiffPixels(imgA, shiftedB, tolerance);
                    if (diffCount < best.diff) {
                        best = { diff: diffCount, dx, dy };
                    }
                }
            }
            return best;
        }

        // Build a diff image between two ImageData objects using the color tolerance.
        function buildDiffImage(imgA, imgB, diffImage, tolerance) {
            const target = diffImage.data;
            const dataA = imgA.data;
            const dataB = imgB.data;
            let diffPixels = 0;

            for (let i = 0; i < dataA.length; i += 4) {
                if (pixelDelta(dataA, dataB, i) > tolerance) {
                    target[i] = 255;
                    target[i + 1] = 0;
                    target[i + 2] = 0;
                    target[i + 3] = 255;
                    diffPixels++;
                } else {
                    target[i] = 0;
                    target[i + 1] = 0;
                    target[i + 2] = 0;
                    target[i + 3] = 0;
                }
            }

            return diffPixels;
        }

        // Enlarge diff areas so tiny letter changes highlight the nearby word/line.
        function dilateDiffMask(diffImage, width, height, radius = 0) {
            const src = diffImage.data;
            const mask = new Uint8Array(width * height);

            // Build binary mask from existing diff pixels.
            for (let i = 0; i < width * height; i++) {
                if (src[i * 4] > 0) {
                    mask[i] = 1;
                }
            }

            // Start with the base mask; optionally expand.
            const expanded = new Uint8Array(mask);
            if (radius > 0) {
                for (let y = 0; y < height; y++) {
                    for (let x = 0; x < width; x++) {
                        const idx = y * width + x;
                        if (!mask[idx]) continue;
                        const yMin = Math.max(0, y - radius);
                        const yMax = Math.min(height - 1, y + radius);
                        const xMin = Math.max(0, x - radius);
                        const xMax = Math.min(width - 1, x + radius);
                        for (let ny = yMin; ny <= yMax; ny++) {
                            for (let nx = xMin; nx <= xMax; nx++) {
                                expanded[ny * width + nx] = 1;
                            }
                        }
                    }
                }
            }

            // Rewrite the diffImage with the expanded mask in solid red.
            for (let i = 0; i < width * height; i++) {
                const base = i * 4;
                if (expanded[i]) {
                    src[base] = 255;
                    src[base + 1] = 0;
                    src[base + 2] = 0;
                    src[base + 3] = 255;
                }
            }
        }

        function extractDiffBoxes(diffImage, width, height, minArea = 25) {
            const data = diffImage.data;
            const visited = new Uint8Array(width * height);
            const boxes = [];

            const directions = [1, -1, width, -width];

            for (let idx = 0; idx < width * height; idx++) {
                if (visited[idx]) continue;
                if (data[idx * 4 + 3] === 0) continue;

                let minX = idx % width;
                let maxX = minX;
                let minY = Math.floor(idx / width);
                let maxY = minY;

                const stack = [idx];
                visited[idx] = 1;

                while (stack.length) {
                    const current = stack.pop();
                    const cx = current % width;
                    const cy = Math.floor(current / width);

                    if (cx < minX) minX = cx;
                    if (cx > maxX) maxX = cx;
                    if (cy < minY) minY = cy;
                    if (cy > maxY) maxY = cy;

                    for (const dir of directions) {
                        const next = current + dir;
                        if (next < 0 || next >= width * height) continue;
                        const nx = next % width;
                        const ny = Math.floor(next / width);
                        if (Math.abs(nx - cx) + Math.abs(ny - cy) !== 1) continue;
                        if (visited[next]) continue;
                        if (data[next * 4 + 3] === 0) continue;
                        visited[next] = 1;
                        stack.push(next);
                    }
                }

                const area = (maxX - minX + 1) * (maxY - minY + 1);
                if (area >= minArea) {
                    boxes.push({
                        x: minX,
                        y: minY,
                        width: maxX - minX + 1,
                        height: maxY - minY + 1
                    });
                }
            }

            return boxes;
        }

        function drawHighlightBoxes(ctx, boxes, color = 'red') {
            ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
            const alpha = HIGHLIGHT_ALPHA;
            if (color === 'red') {
                ctx.fillStyle = `rgba(255, 0, 0, ${alpha})`;
            } else if (color === 'green') {
                ctx.fillStyle = `rgba(0, 200, 0, ${alpha})`;
            }
            boxes.forEach(({ x, y, width, height }) => {
                ctx.fillRect(x, y, width, height);
            });
        }

        function rectsIntersect(a, b) {
            return (
                a.x < b.x + b.width &&
                a.x + a.width > b.x &&
                a.y < b.y + b.height &&
                a.y + a.height > b.y
            );
        }

        function dedupeBoxes(boxes) {
            const seen = new Set();
            const result = [];
            boxes.forEach((box) => {
                const key = [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(":");
                if (seen.has(key)) {
                    return;
                }
                seen.add(key);
                result.push({ x: box.x, y: box.y, width: box.width, height: box.height });
            });
            return result;
        }

        function padBox(box, paddingX, paddingY) {
            const x = Math.max(0, box.x - paddingX);
            const y = Math.max(0, box.y - paddingY);
            return {
                x,
                y,
                width: Math.max(1, box.width + paddingX * 2),
                height: Math.max(1, box.height + paddingY * 2)
            };
        }

        function mapDiffsToWordBoxes(diffBoxes, wordBoxes) {
            if (!wordBoxes || !wordBoxes.length) {
                return diffBoxes;
            }

            const matched = [];

            diffBoxes.forEach((diffBox) => {
                let found = false;
                for (const word of wordBoxes) {
                    if (rectsIntersect(diffBox, word)) {
                        // Skip tiny word boxes (likely rendering noise)
                        if (word.width >= MIN_WORD_SIZE && word.height >= MIN_WORD_SIZE) {
                            matched.push(word);
                            found = true;
                        }
                    }
                }
                if (!found) {
                    matched.push(diffBox);
                }
            });

            return dedupeBoxes(matched);
        }

        function translateBoxes(boxes, dx, dy) {
            return boxes.map((box) => ({
                x: box.x + dx,
                y: box.y + dy,
                width: box.width,
                height: box.height
            }));
        }

        function offsetWordBoxes(words, crop) {
            if (!crop) return words;
            return words.map(box => ({
                ...box,
                x: box.x - crop.x,
                y: box.y - crop.y
            }));
        }

        function canvasToImageData(canvas) {
            const ctx = canvas.getContext("2d");
            return ctx.getImageData(0, 0, canvas.width, canvas.height);
        }

        function downloadZip(zip, filename) {
            zip.generateAsync({ type: "blob" }).then(function (blob) {
                const a = document.createElement("a");
                a.href = URL.createObjectURL(blob);
                a.download = filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
            });
        }

        function applyCrop(canvas, region) {
            if (!region) return canvas;
            const cropped = document.createElement("canvas");
            cropped.width = region.width;
            cropped.height = region.height;
            const ctx = cropped.getContext("2d");
            ctx.drawImage(
                canvas,
                region.x, region.y, region.width, region.height,
                0, 0, region.width, region.height
            );
            return cropped;
        }

        function applyMasks(diffImage, masks) {
            if (!masks?.length) return;
            const data = diffImage.data;
            masks.forEach(({ x, y, width, height }) => {
                for (let row = y; row < y + height; row++) {
                    for (let col = x; col < x + width; col++) {
                        const idx = (row * diffImage.width + col) * 4;
                        data[idx] = data[idx + 1] = data[idx + 2] = data[idx + 3] = 0;
                    }
                }
            });
        }

        // === Blend diff over a base image ===
        function overlayDiff(baseCanvas, diffCanvas, opacity = 0.3) {
            const overlay = document.createElement("canvas");
            overlay.width = baseCanvas.width;
            overlay.height = baseCanvas.height;

            const ctx = overlay.getContext("2d");

            ctx.drawImage(baseCanvas, 0, 0);
            ctx.globalAlpha = opacity;
            ctx.drawImage(diffCanvas, 0, 0);
            ctx.globalAlpha = 1;
            ctx.imageSmoothingEnabled = false;

            return overlay;
        }

        // Store PDFs for cleanup
        let currentPdfA = null;
        let currentPdfB = null;

        // Cleanup function to clear all resources
        function cleanup() {
            // Clear canvases
            const canvasA = document.getElementById("canvasA");
            const canvasB = document.getElementById("canvasB");
            const canvasDiff = document.getElementById("canvasDiff");
            
            if (canvasA) {
                const ctxA = canvasA.getContext("2d");
                ctxA.clearRect(0, 0, canvasA.width, canvasA.height);
                canvasA.width = 0;
                canvasA.height = 0;
            }
            
            if (canvasB) {
                const ctxB = canvasB.getContext("2d");
                ctxB.clearRect(0, 0, canvasB.width, canvasB.height);
                canvasB.width = 0;
                canvasB.height = 0;
            }
            
            if (canvasDiff) {
                const ctxDiff = canvasDiff.getContext("2d");
                ctxDiff.clearRect(0, 0, canvasDiff.width, canvasDiff.height);
                canvasDiff.width = 0;
                canvasDiff.height = 0;
            }
            
            // Clear results div
            const resultsDiv = document.getElementById("results");
            if (resultsDiv) {
                resultsDiv.innerHTML = "";
            }
            
            // Destroy PDF documents to free memory
            if (currentPdfA) {
                currentPdfA.destroy();
                currentPdfA = null;
            }
            if (currentPdfB) {
                currentPdfB.destroy();
                currentPdfB = null;
            }
            
            // Force garbage collection hint
            if (window.gc) {
                window.gc();
            }
        }

        $scope.compare = async function () {
            // Clear previous results and free memory
            cleanup();
            
            const LABEL_A = "Document A";
            const LABEL_B = "Document B";
            const fileA = document.getElementById("fileA").files[0];
            const fileB = document.getElementById("fileB").files[0];

            // Optional: Define regions to crop (limit comparison to specific areas)
            const cropRegions = [
                // { page: 1, x: 100, y: 150, width: 400, height: 200 }
            ];
            // Optional: Define regions to mask (ignore dynamic content like dates)
            const maskRegions = [
                // { page: 1, x: 50, y: 30, width: 200, height: 60 }
            ];
            
            console.log('Crop regions:', cropRegions);
            console.log('Mask regions:', maskRegions);

            if (!fileA || !fileB) {
                alert("Select both PDFs first!");
                return;
            }

            const arrayBufferA = await fileA.arrayBuffer();
            const arrayBufferB = await fileB.arrayBuffer();

            currentPdfA = await pdfjsLib.getDocument({ data: arrayBufferA }).promise;
            currentPdfB = await pdfjsLib.getDocument({ data: arrayBufferB }).promise;
            const pdfA = currentPdfA;
            const pdfB = currentPdfB;

            const maxPages = Math.max(pdfA.numPages, pdfB.numPages);
            
            if (pdfA.numPages !== pdfB.numPages) {
                const message = `Page count differs: ${LABEL_A} has ${pdfA.numPages} page(s), ${LABEL_B} has ${pdfB.numPages} page(s). Showing all ${maxPages} page(s).`;
                console.warn(message);
                // alert(message);
            }

            const canvasA = document.getElementById("canvasA");
            const canvasB = document.getElementById("canvasB");
            const canvasDiff = document.getElementById("canvasDiff");

            const resultsDiv = document.getElementById("results");
            // resultsDiv already cleared in cleanup()

            // const zip = new JSZip();
            let totalDiffPixels = 0;

            for (let i = 1; i <= maxPages; i++) {

                const hasPageA = i <= pdfA.numPages;
                const hasPageB = i <= pdfB.numPages;

                // Handle pages that only exist in one document
                if (!hasPageA || !hasPageB) {
                    const title = document.createElement("h4");
                    title.innerText = `Page ${i}`;

                    const row = document.createElement("div");
                    row.style.display = "grid";
                    row.style.gridTemplateColumns = "1fr 1fr";
                    row.style.gap = "15px";
                    row.style.marginBottom = "25px";
                    row.style.borderTop = "2px solid #ddd";
                    row.style.paddingTop = "15px";

                    function makeEmptyCol(labelText) {
                        const col = document.createElement("div");
                        const label = document.createElement("div");
                        label.innerHTML = `<b>${labelText}</b>`;

                        const placeholder = document.createElement("div");
                        placeholder.style.padding = "40px";
                        placeholder.style.textAlign = "center";
                        placeholder.style.backgroundColor = "#f5f5f5";
                        placeholder.style.border = "1px solid #ccc";
                        placeholder.style.color = "#999";
                        placeholder.innerText = "No corresponding page";

                        col.appendChild(label);
                        col.appendChild(placeholder);
                        return col;
                    }

                    function makePageCol(labelText, canvas) {
                        const col = document.createElement("div");
                        const label = document.createElement("div");
                        label.innerHTML = `<b>${labelText}</b>`;

                        const img = document.createElement("img");
                        img.src = canvas.toDataURL("image/png");
                        img.style.width = "100%";
                        img.style.border = "1px solid #ccc";
                        img.style.imageRendering = "crisp-edges";
                        img.style.backgroundColor = "#fff";

                        col.appendChild(label);
                        col.appendChild(img);
                        return col;
                    }

                    if (hasPageA && !hasPageB) {
                        // Only in Document A
                        await renderPageToCanvas(pdfA, i, canvasA);
                        const colA = makePageCol(`${LABEL_A} (only)`, canvasA);
                        const colB = makeEmptyCol(`${LABEL_B} (no page ${i})`);
                        row.appendChild(colA);
                        row.appendChild(colB);
                    } else if (!hasPageA && hasPageB) {
                        // Only in Document B
                        await renderPageToCanvas(pdfB, i, canvasB);
                        const colA = makeEmptyCol(`${LABEL_A} (no page ${i})`);
                        const colB = makePageCol(`${LABEL_B} (only)`, canvasB);
                        row.appendChild(colA);
                        row.appendChild(colB);
                    }

                    resultsDiv.appendChild(title);
                    resultsDiv.appendChild(row);
                    continue;
                }

                // Both pages exist - do normal comparison
                const { words: wordsA } = await renderPageToCanvas(pdfA, i, canvasA);
                const { words: wordsB } = await renderPageToCanvas(pdfB, i, canvasB);

                const pageCrop = cropRegions.find(r => r.page === i);
                const croppedWordsA = offsetWordBoxes(wordsA, pageCrop);
                const croppedWordsB = offsetWordBoxes(wordsB, pageCrop);

                const croppedA = applyCrop(canvasA, pageCrop);
                const croppedB = applyCrop(canvasB, pageCrop);
                const targetWidth = Math.max(croppedA.width, croppedB.width);
                const targetHeight = Math.max(croppedA.height, croppedB.height);

                const paddedA = padCanvas(croppedA, targetWidth, targetHeight);
                const paddedB = padCanvas(croppedB, targetWidth, targetHeight);

                const highlightCanvasB = document.createElement("canvas");
                highlightCanvasB.width = targetWidth;
                highlightCanvasB.height = targetHeight;
                const highlightCtxB = highlightCanvasB.getContext("2d");

                const imgA = canvasToImageData(paddedA);
                const imgB = canvasToImageData(paddedB);

                canvasDiff.width = targetWidth;
                canvasDiff.height = targetHeight;

                const ctxDiff = canvasDiff.getContext("2d");
                ctxDiff.clearRect(0, 0, canvasDiff.width, canvasDiff.height);
                const diffImage = ctxDiff.createImageData(imgA.width, imgA.height);

                // Find best small translation to reduce reflow-induced diffs.
                const best = findBestOffset(imgA, paddedB, imgA.width, imgA.height, COLOR_TOLERANCE);
                const shiftedB = getShiftedImageData(paddedB, imgA.width, imgA.height, best.dx, best.dy);

                const diffPixels = buildDiffImage(imgA, shiftedB, diffImage, COLOR_TOLERANCE);

                // Apply masks to ignore specified regions
                const pageMasks = maskRegions.filter(r => r.page === i);
                applyMasks(diffImage, pageMasks);

                // Expand mask so a tiny letter change highlights its word/line.
                dilateDiffMask(diffImage, imgA.width, imgA.height, DILATION_RADIUS);

                const boxes = extractDiffBoxes(diffImage, imgA.width, imgA.height, MIN_HIGHLIGHT_AREA);
                totalDiffPixels += diffPixels;

                const wordHighlightsA = mapDiffsToWordBoxes(boxes, croppedWordsA);
                drawHighlightBoxes(ctxDiff, wordHighlightsA, 'red');  // LEFT = RED

                const boxesForB = translateBoxes(boxes, -best.dx, -best.dy);
                const wordHighlightsB = mapDiffsToWordBoxes(boxesForB, croppedWordsB);
                drawHighlightBoxes(highlightCtxB, wordHighlightsB, 'green');  // RIGHT = GREEN
                // Create overlays
                const overlayOnA = overlayDiff(paddedA, canvasDiff);
                const overlayOnB = overlayDiff(paddedB, highlightCanvasB);

                // Save PURE diff to ZIP (still kept)
                const diffDataUrl = canvasDiff.toDataURL("image/png");
                const base64 = diffDataUrl.split(",")[1];
                // zip.file(`diff_page_${i}.png`, base64, { base64: true });

                // ---- UI Layout (2 columns only) ----
                const title = document.createElement("h4");
                title.innerText = `Page ${i}`;
                // title.innerText = `Page ${i} — Diff pixels: ${diffPixels}`;

                const row = document.createElement("div");
                row.style.display = "grid";
                row.style.gridTemplateColumns = "1fr 1fr";
                row.style.gap = "15px";
                row.style.marginBottom = "25px";
                row.style.borderTop = "2px solid #ddd";
                row.style.paddingTop = "15px";

                function makeCol(labelText, canvas) {
                    const col = document.createElement("div");
                    const label = document.createElement("div");
                    label.innerHTML = `<b>${labelText}</b>`;

                    const img = document.createElement("img");
                    img.src = canvas.toDataURL("image/png");
                    img.style.width = "100%";
                    img.style.border = "1px solid #ccc";
                    img.style.imageRendering = "crisp-edges";
                    img.style.backgroundColor = "#fff";

                    col.appendChild(label);
                    col.appendChild(img);
                    return col;
                }

                function makeEmptyCol(labelText) {
                    const col = document.createElement("div");
                    const label = document.createElement("div");
                    label.innerHTML = `<b>${labelText}</b>`;

                    const placeholder = document.createElement("div");
                    placeholder.style.padding = "40px";
                    placeholder.style.textAlign = "center";
                    placeholder.style.backgroundColor = "#f5f5f5";
                    placeholder.style.border = "1px solid #ccc";
                    placeholder.style.color = "#999";
                    placeholder.innerText = "No corresponding page";

                    col.appendChild(label);
                    col.appendChild(placeholder);
                    return col;
                }

                resultsDiv.appendChild(title);
                row.appendChild(makeCol(LABEL_A, overlayOnA));
                row.appendChild(makeCol(LABEL_B, overlayOnB));

                resultsDiv.appendChild(row);
            }

            const summary = document.createElement("h3");
            summary.innerHTML =
                ``;
            // `Total pixel differences across all pages: ${totalDiffPixels}`;
            resultsDiv.prepend(summary);

            // downloadZip(zip, "pdf-diff-results.zip");
        };

    });
