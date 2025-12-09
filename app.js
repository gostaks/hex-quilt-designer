/**
 * Hex Quilt Designer
 * 
 * A tool for designing hexagon quilts with:
 * - Custom color palettes with quantity limits
 * - Gradient generation from anchor points
 * - Drag-and-drop hex swapping
 * - Undo/redo support
 */

// ============================================================================
// State Management
// ============================================================================

const state = {
    // Grid configuration (real-world units)
    hexRealSize: 2,      // size in inches or cm (point-to-point)
    quiltWidth: 30,      // width in inches or cm
    quiltHeight: 40,     // height in inches or cm
    unit: 'in',          // 'in' or 'cm'
    
    // Calculated grid dimensions
    cols: 0,
    rows: 0,
    hexSize: 30,         // display size in pixels
    
    // Grid data: array of {color: string|null, colorId: number|null, locked: boolean}
    grid: [],
    
    // Color palette: array of {id: number, color: string, total: number}
    colors: [],
    nextColorId: 1,
    selectedColorId: null,
    
    // Color being edited
    editingColorId: null,
    
    // Anchors for gradient: array of {row, col, colorId}
    anchors: [],
    
    // Current tool: 'paint', 'swap', 'anchor', 'lock', 'erase'
    tool: 'paint',
    
    // Brush size for paint/erase
    brushSize: 1, // radius in hexes
    
    // Swap mode state
    swapSource: null, // {row, col}
    
    // Drag painting state
    isDragging: false,
    dragAction: null, // stores action for continuous drag
    
    // Image picker state
    imagePicker: {
        pickedColors: [],
        history: [],
        historyIndex: -1,
        imageData: null
    },
    
    // Gradient options
    gradientDither: false,
    ditherIntensity: 5,
    
    // Display options
    showNumbers: false,
    
    // Sidebar collapsed state
    sidebarCollapsed: false,
    
    // Zoom level
    zoom: 1.0,
    
    // History for undo/redo
    history: [],
    historyIndex: -1,
    maxHistory: 50
};

// ============================================================================
// Hex Grid Math (Pointy-Top Hexagons)
// ============================================================================

/**
 * Calculate how many hexes fit in given dimensions
 * For pointy-top hexes:
 * - Width of hex = sqrt(3) * size (point-to-point across flat sides)
 * - Height of hex = 2 * size (point-to-point)
 * - Horizontal spacing = width
 * - Vertical spacing = height * 0.75 (3/4 height due to nesting)
 */
function calculateGridDimensions(hexSize, quiltWidth, quiltHeight) {
    // For pointy-top hex, "size" is the distance from center to point
    // Point-to-point height = 2 * size
    // So if user says "2 inch hex", that's the point-to-point measurement
    const hexHeight = hexSize;  // point-to-point (user's measurement)
    const radius = hexHeight / 2;
    const hexWidth = Math.sqrt(3) * radius;
    
    // Horizontal: first hex takes full width, subsequent hexes overlap
    const horizontalSpacing = hexWidth;
    const cols = Math.floor((quiltWidth - hexWidth / 2) / horizontalSpacing) + 1;
    
    // Vertical: hexes nest with 3/4 overlap
    const verticalSpacing = hexHeight * 0.75;
    const rows = Math.floor((quiltHeight - hexHeight / 4) / verticalSpacing) + 1;
    
    return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

/**
 * Calculate pixel position for a hex at grid coordinates
 * Pointy-top hexagon layout with offset coordinates (odd-r)
 */
function hexToPixel(col, row, size) {
    const width = Math.sqrt(3) * size;
    const height = 2 * size;
    const vertSpacing = height * 0.75;
    
    // Offset odd rows to the right
    const xOffset = (row % 2 === 1) ? width / 2 : 0;
    
    const x = col * width + xOffset + size * Math.sqrt(3) / 2;
    const y = row * vertSpacing + size;
    
    return { x, y };
}

/**
 * Generate SVG path for a pointy-top hexagon
 */
function hexPath(cx, cy, size) {
    const points = [];
    for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 180) * (60 * i - 30);
        const x = cx + size * Math.cos(angle);
        const y = cy + size * Math.sin(angle);
        points.push(`${x},${y}`);
    }
    return `M${points.join('L')}Z`;
}

/**
 * Calculate SVG canvas size needed for the grid
 */
function calculateCanvasSize(cols, rows, size) {
    const width = Math.sqrt(3) * size;
    const height = 2 * size;
    const vertSpacing = height * 0.75;
    
    const canvasWidth = cols * width + width / 2 + size;
    const canvasHeight = rows * vertSpacing + size / 2 + size;
    
    return { width: canvasWidth, height: canvasHeight };
}

// ============================================================================
// Color Utilities
// ============================================================================

/**
 * Parse hex color to RGB
 */
function hexToRgb(hex) {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
}

/**
 * Convert RGB to hex
 */
function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.round(Math.max(0, Math.min(255, x))).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

/**
 * Calculate color distance (simple Euclidean in RGB space)
 */
function colorDistance(c1, c2) {
    const rgb1 = hexToRgb(c1);
    const rgb2 = hexToRgb(c2);
    if (!rgb1 || !rgb2) return Infinity;
    
    return Math.sqrt(
        Math.pow(rgb1.r - rgb2.r, 2) +
        Math.pow(rgb1.g - rgb2.g, 2) +
        Math.pow(rgb1.b - rgb2.b, 2)
    );
}

/**
 * Convert RGB to XYZ color space (D65 illuminant)
 */
function rgbToXyz(r, g, b) {
    // Normalize to 0-1
    let rNorm = r / 255;
    let gNorm = g / 255;
    let bNorm = b / 255;
    
    // Gamma correction (inverse sRGB companding)
    rNorm = rNorm > 0.04045 ? Math.pow((rNorm + 0.055) / 1.055, 2.4) : rNorm / 12.92;
    gNorm = gNorm > 0.04045 ? Math.pow((gNorm + 0.055) / 1.055, 2.4) : gNorm / 12.92;
    bNorm = bNorm > 0.04045 ? Math.pow((bNorm + 0.055) / 1.055, 2.4) : bNorm / 12.92;
    
    // Apply sRGB to XYZ transformation matrix
    const x = rNorm * 0.4124564 + gNorm * 0.3575761 + bNorm * 0.1804375;
    const y = rNorm * 0.2126729 + gNorm * 0.7151522 + bNorm * 0.0721750;
    const z = rNorm * 0.0193339 + gNorm * 0.1191920 + bNorm * 0.9503041;
    
    return { x: x * 100, y: y * 100, z: z * 100 };
}

/**
 * Convert XYZ to LAB color space
 */
function xyzToLab(x, y, z) {
    // D65 standard illuminant
    const refX = 95.047;
    const refY = 100.000;
    const refZ = 108.883;
    
    let xNorm = x / refX;
    let yNorm = y / refY;
    let zNorm = z / refZ;
    
    // Apply nonlinear transformation
    const f = (t) => t > 0.008856 ? Math.pow(t, 1/3) : (7.787 * t) + (16/116);
    
    xNorm = f(xNorm);
    yNorm = f(yNorm);
    zNorm = f(zNorm);
    
    const L = (116 * yNorm) - 16;
    const a = 500 * (xNorm - yNorm);
    const b = 200 * (yNorm - zNorm);
    
    return { L, a, b };
}

/**
 * Convert LAB to XYZ color space
 */
function labToXyz(L, a, b) {
    const refX = 95.047;
    const refY = 100.000;
    const refZ = 108.883;
    
    let y = (L + 16) / 116;
    let x = a / 500 + y;
    let z = y - b / 200;
    
    const f = (t) => {
        const t3 = Math.pow(t, 3);
        return t3 > 0.008856 ? t3 : (t - 16/116) / 7.787;
    };
    
    x = refX * f(x);
    y = refY * f(y);
    z = refZ * f(z);
    
    return { x, y, z };
}

/**
 * Convert XYZ to RGB
 */
function xyzToRgb(x, y, z) {
    x = x / 100;
    y = y / 100;
    z = z / 100;
    
    // Apply XYZ to sRGB transformation matrix
    let r = x *  3.2404542 + y * -1.5371385 + z * -0.4985314;
    let g = x * -0.9692660 + y *  1.8760108 + z *  0.0415560;
    let b = x *  0.0556434 + y * -0.2040259 + z *  1.0572252;
    
    // Apply sRGB companding
    r = r > 0.0031308 ? 1.055 * Math.pow(r, 1/2.4) - 0.055 : 12.92 * r;
    g = g > 0.0031308 ? 1.055 * Math.pow(g, 1/2.4) - 0.055 : 12.92 * g;
    b = b > 0.0031308 ? 1.055 * Math.pow(b, 1/2.4) - 0.055 : 12.92 * b;
    
    // Clamp and convert to 0-255
    r = Math.max(0, Math.min(255, Math.round(r * 255)));
    g = Math.max(0, Math.min(255, Math.round(g * 255)));
    b = Math.max(0, Math.min(255, Math.round(b * 255)));
    
    return { r, g, b };
}

/**
 * Convert RGB to LAB (perceptually uniform color space)
 */
function rgbToLab(r, g, b) {
    const xyz = rgbToXyz(r, g, b);
    return xyzToLab(xyz.x, xyz.y, xyz.z);
}

/**
 * Convert LAB to RGB
 */
function labToRgb(L, a, b) {
    const xyz = labToXyz(L, a, b);
    return xyzToRgb(xyz.x, xyz.y, xyz.z);
}

/**
 * Perceptual color distance using LAB (deltaE)
 */
function colorDistanceLab(hex1, hex2) {
    const rgb1 = hexToRgb(hex1);
    const rgb2 = hexToRgb(hex2);
    if (!rgb1 || !rgb2) return Infinity;
    
    const lab1 = rgbToLab(rgb1.r, rgb1.g, rgb1.b);
    const lab2 = rgbToLab(rgb2.r, rgb2.g, rgb2.b);
    
    // deltaE CIE 1976
    return Math.sqrt(
        Math.pow(lab1.L - lab2.L, 2) +
        Math.pow(lab1.a - lab2.a, 2) +
        Math.pow(lab1.b - lab2.b, 2)
    );
}

/**
 * Determine if a color is light (for text contrast)
 */
function isLightColor(hex) {
    const rgb = hexToRgb(hex);
    if (!rgb) return false;
    // Using relative luminance formula
    const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
    return luminance > 0.5;
}

/**
 * Blend multiple colors with weights
 */
function blendColors(colorWeights) {
    // colorWeights: array of {color: hex, weight: number}
    // Blend in LAB color space for perceptually uniform results
    let L = 0, a = 0, b = 0, totalWeight = 0;
    
    for (const { color, weight } of colorWeights) {
        const rgb = hexToRgb(color);
        if (rgb && weight > 0) {
            const lab = rgbToLab(rgb.r, rgb.g, rgb.b);
            L += lab.L * weight;
            a += lab.a * weight;
            b += lab.b * weight;
            totalWeight += weight;
        }
    }
    
    if (totalWeight === 0) return null;
    
    // Average the LAB values
    L = L / totalWeight;
    a = a / totalWeight;
    b = b / totalWeight;
    
    // Convert back to RGB
    const rgb = labToRgb(L, a, b);
    return rgbToHex(rgb.r, rgb.g, rgb.b);
}

// ============================================================================
// Grid Management
// ============================================================================

/**
 * Initialize empty grid
 */
function initializeGrid() {
    state.grid = [];
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            state.grid.push({ color: null, colorId: null, locked: false });
        }
    }
    state.anchors = [];
    state.swapSource = null;
}

/**
 * Get grid index from row/col
 */
function gridIndex(row, col) {
    return row * state.cols + col;
}

/**
 * Get cell at row/col
 */
function getCell(row, col) {
    if (row < 0 || row >= state.rows || col < 0 || col >= state.cols) {
        return null;
    }
    return state.grid[gridIndex(row, col)];
}

/**
 * Get all hexes within a given radius (using hex distance)
 * For offset coordinates (odd-r), convert to cube coordinates
 */
function getHexesInRadius(centerRow, centerCol, radius) {
    const hexes = [];
    
    // Convert center to cube coordinates (x, y, z where x+y+z=0)
    const centerX = centerCol - Math.floor(centerRow / 2);
    const centerZ = centerRow;
    const centerY = -centerX - centerZ;
    
    // Check all hexes in grid
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            // Convert to cube coordinates
            const x = col - Math.floor(row / 2);
            const z = row;
            const y = -x - z;
            
            // Calculate hex distance (Manhattan distance in cube coords / 2)
            const distance = (Math.abs(centerX - x) + Math.abs(centerY - y) + Math.abs(centerZ - z)) / 2;
            
            if (distance <= radius) {
                hexes.push({ row, col });
            }
        }
    }
    
    return hexes;
}

/**
 * Set cell color
 */
function setCell(row, col, colorId) {
    const cell = getCell(row, col);
    if (colorId === null) {
        cell.color = null;
        cell.colorId = null;
    } else {
        const colorObj = state.colors.find(c => c.id === colorId);
        if (colorObj) {
            cell.color = colorObj.color;
            cell.colorId = colorId;
        }
    }
}

// ============================================================================
// History (Undo/Redo)
// ============================================================================

/**
 * Save current grid state to history
 */
function saveToHistory() {
    // Remove any redo states
    state.history = state.history.slice(0, state.historyIndex + 1);
    
    // Save current state
    const snapshot = {
        grid: state.grid.map(cell => ({ ...cell })),
        anchors: state.anchors.map(a => ({ ...a }))
    };
    
    state.history.push(snapshot);
    
    // Trim history if too long
    if (state.history.length > state.maxHistory) {
        state.history.shift();
    } else {
        state.historyIndex++;
    }
    
    updateHistoryButtons();
}

/**
 * Restore grid state from history
 */
function restoreFromHistory(snapshot) {
    state.grid = snapshot.grid.map(cell => ({ ...cell }));
    state.anchors = snapshot.anchors.map(a => ({ ...a }));
    state.swapSource = null;
    renderGrid();
    updateColorCounts();
}

function undo() {
    if (state.historyIndex > 0) {
        state.historyIndex--;
        restoreFromHistory(state.history[state.historyIndex]);
        updateHistoryButtons();
        setStatus('Undid last action');
    }
}

function redo() {
    if (state.historyIndex < state.history.length - 1) {
        state.historyIndex++;
        restoreFromHistory(state.history[state.historyIndex]);
        updateHistoryButtons();
        setStatus('Redid action');
    }
}

function updateHistoryButtons() {
    const undoDisabled = state.historyIndex <= 0;
    const redoDisabled = state.historyIndex >= state.history.length - 1;
    
    document.getElementById('undo').disabled = undoDisabled;
    document.getElementById('redo').disabled = redoDisabled;
    
    // Also update mini toolbar buttons
    const miniUndo = document.getElementById('mini-undo');
    const miniRedo = document.getElementById('mini-redo');
    if (miniUndo) miniUndo.disabled = undoDisabled;
    if (miniRedo) miniRedo.disabled = redoDisabled;
}

// ============================================================================
// Rendering
// ============================================================================

/**
 * Render the entire hex grid
 */
function renderGrid() {
    const svg = document.getElementById('hex-grid');
    const { width, height } = calculateCanvasSize(state.cols, state.rows, state.hexSize);
    
    svg.setAttribute('width', width);
    svg.setAttribute('height', height);
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    
    // Clear existing content
    svg.innerHTML = '';
    
    // Render hexagons
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            const cell = getCell(row, col);
            const { x, y } = hexToPixel(col, row, state.hexSize);
            
            // Create hex path
            const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
            path.setAttribute('d', hexPath(x, y, state.hexSize * 0.95)); // Slight gap between hexes
            path.setAttribute('class', 'hex' + (cell.color ? '' : ' empty'));
            path.setAttribute('fill', cell.color || '#ffffff');
            path.setAttribute('data-row', row);
            path.setAttribute('data-col', col);
            
            // Check if this is swap source
            if (state.swapSource && state.swapSource.row === row && state.swapSource.col === col) {
                path.classList.add('swap-source');
            }
            
            // Check if this is an anchor
            const anchor = state.anchors.find(a => a.row === row && a.col === col);
            if (anchor) {
                path.classList.add('anchor');
            }
            
            // Check if this cell is locked
            if (cell.locked) {
                path.classList.add('locked');
            }
            
            svg.appendChild(path);
            
            // Add color number if enabled and cell has color
            if (state.showNumbers && cell.colorId !== null) {
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', x);
                text.setAttribute('y', y);
                text.setAttribute('class', 'hex-number ' + (isLightColor(cell.color) ? 'light-bg' : 'dark-bg'));
                text.textContent = cell.colorId;
                svg.appendChild(text);
            }
            
            // Add anchor marker if this is an anchor - now shows the color!
            if (anchor) {
                const colorObj = state.colors.find(c => c.id === anchor.colorId);
                const anchorColor = colorObj ? colorObj.color : '#888888';
                
                // Draw a small hexagon marker showing the anchor color
                const markerSize = state.hexSize * 0.3;
                const marker = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                marker.setAttribute('d', hexPath(x, y - state.hexSize * 0.55, markerSize));
                marker.setAttribute('fill', anchorColor);
                marker.setAttribute('class', 'anchor-marker');
                svg.appendChild(marker);
            }
            
            // Add lock indicator if this cell is locked
            if (cell.locked) {
                const lockText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                lockText.setAttribute('x', x);
                lockText.setAttribute('y', y + state.hexSize * 0.55);
                lockText.setAttribute('text-anchor', 'middle');
                lockText.setAttribute('class', 'lock-indicator');
                lockText.textContent = '🔒';
                svg.appendChild(lockText);
            }
        }
    }
    
    updateStats();
}

/**
 * Update grid info display
 */
function updateGridInfo() {
    const dims = calculateGridDimensions(state.hexRealSize, state.quiltWidth, state.quiltHeight);
    const totalHexes = dims.cols * dims.rows;
    const infoEl = document.getElementById('grid-info');
    infoEl.textContent = `${dims.cols} × ${dims.rows} = ${totalHexes} hexagons`;
}

// ============================================================================
// Color Palette Management
// ============================================================================

/**
 * Add a new color to the palette
 */
function addColor(hexColor, total) {
    const colorObj = {
        id: state.nextColorId++,
        color: hexColor,
        total: total
    };
    state.colors.push(colorObj);
    renderColorList();
    updateStats();
    return colorObj;
}

/**
 * Remove a color from the palette
 */
function removeColor(colorId) {
    const index = state.colors.findIndex(c => c.id === colorId);
    if (index === -1) return;
    
    state.colors.splice(index, 1);
    
    // Clear cells with this color
    for (const cell of state.grid) {
        if (cell.colorId === colorId) {
            cell.color = null;
            cell.colorId = null;
        }
    }
    
    // Remove anchors with this color
    state.anchors = state.anchors.filter(a => a.colorId !== colorId);
    
    if (state.selectedColorId === colorId) {
        state.selectedColorId = null;
    }
    
    // Close editor if editing this color
    if (state.editingColorId === colorId) {
        closeColorEditor();
    }
    
    renderColorList();
    renderGrid();
}

/**
 * Update a color's quantity
 */
function updateColorQuantity(colorId, newTotal) {
    const colorObj = state.colors.find(c => c.id === colorId);
    if (colorObj) {
        colorObj.total = Math.max(0, newTotal);
        renderColorList();
        updateStats();
    }
}

/**
 * Count how many cells have a given color
 */
function countColorUsage(colorId) {
    return state.grid.filter(cell => cell.colorId === colorId).length;
}

/**
 * Render the color palette list as hexagon swatches
 */
function renderColorList() {
    const list = document.getElementById('color-list');
    list.innerHTML = '';
    
    const swatchSize = 28; // radius for the hex swatch
    
    for (const colorObj of state.colors) {
        const used = countColorUsage(colorObj.id);
        const remaining = colorObj.total - used;
        
        const item = document.createElement('div');
        item.className = 'color-item' + (state.selectedColorId === colorObj.id ? ' selected' : '');
        item.dataset.colorId = colorObj.id;
        
        // Create SVG hex swatch
        const svgSize = swatchSize * 2.2;
        const cx = svgSize / 2;
        const cy = svgSize / 2;
        
        item.innerHTML = `
            <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}">
                <path d="${hexPath(cx, cy, swatchSize)}" fill="${colorObj.color}" class="hex-swatch"/>
                <text x="${cx}" y="${cy + 1}" text-anchor="middle" dominant-baseline="middle" 
                      style="font-size: 11px; fill: ${isLightColor(colorObj.color) ? '#4a4540' : '#fff'}; font-weight: 500;">
                    ${colorObj.id}
                </text>
            </svg>
            <div class="color-item-info">
                <span class="${remaining >= 0 ? 'remaining' : 'over'}">${remaining}</span>/${colorObj.total}
            </div>
            <button class="color-remove" data-color-id="${colorObj.id}">×</button>
        `;
        
        list.appendChild(item);
    }
    
    updateColorCounts();
    renderMiniColorSelector();
}

/**
 * Render the mini color selector for collapsed sidebar
 */
function renderMiniColorSelector() {
    const miniList = document.getElementById('mini-color-selector');
    if (!miniList) return;
    
    miniList.innerHTML = '';
    
    const swatchSize = 16; // smaller for mini toolbar
    const svgSize = swatchSize * 2.2;
    const cx = svgSize / 2;
    const cy = svgSize / 2;
    
    for (const colorObj of state.colors) {
        const item = document.createElement('div');
        item.className = 'mini-color-item' + (state.selectedColorId === colorObj.id ? ' selected' : '');
        item.dataset.colorId = colorObj.id;
        item.title = `Color #${colorObj.id}`;
        
        item.innerHTML = `
            <svg width="${svgSize}" height="${svgSize}" viewBox="0 0 ${svgSize} ${svgSize}">
                <path d="${hexPath(cx, cy, swatchSize)}" fill="${colorObj.color}" class="hex-swatch"/>
                <text x="${cx}" y="${cy + 0.5}" text-anchor="middle" dominant-baseline="middle" 
                      style="font-size: 8px; fill: ${isLightColor(colorObj.color) ? '#4a4540' : '#fff'}; font-weight: 500; pointer-events: none;">
                    ${colorObj.id}
                </text>
            </svg>
        `;
        
        miniList.appendChild(item);
    }
}

/**
 * Update the color count statistics
 */
function updateColorCounts() {
    let totalAvailable = 0;
    let totalPlaced = 0;
    
    for (const colorObj of state.colors) {
        totalAvailable += colorObj.total;
        totalPlaced += countColorUsage(colorObj.id);
    }
    
    document.getElementById('total-available').textContent = totalAvailable;
    document.getElementById('total-placed').textContent = totalPlaced;
    document.getElementById('total-cells').textContent = state.grid.length;
    
    // Update individual color items
    renderColorList_countsOnly();
}

/**
 * Update just the counts in color list (without full re-render)
 */
function renderColorList_countsOnly() {
    const items = document.querySelectorAll('.color-item');
    items.forEach(item => {
        const colorId = parseInt(item.dataset.colorId);
        const colorObj = state.colors.find(c => c.id === colorId);
        if (!colorObj) return;
        
        const used = countColorUsage(colorId);
        const remaining = colorObj.total - used;
        
        const infoSpan = item.querySelector('.color-item-info');
        if (infoSpan) {
            infoSpan.innerHTML = `
                <span class="${remaining >= 0 ? 'remaining' : 'over'}">${remaining}</span>/${colorObj.total}
            `;
        }
    });
}

/**
 * Update general statistics
 */
function updateStats() {
    updateColorCounts();
}

// ============================================================================
// Color Editor
// ============================================================================

/**
 * Open the color editor for a specific color
 */
function openColorEditor(colorId) {
    const colorObj = state.colors.find(c => c.id === colorId);
    if (!colorObj) return;
    
    state.editingColorId = colorId;
    
    // Update editor UI
    document.getElementById('editor-swatch').style.backgroundColor = colorObj.color;
    document.getElementById('editor-color-id').textContent = colorId;
    document.getElementById('editor-qty').value = colorObj.total;
    
    // Show editor
    document.getElementById('color-editor').classList.add('visible');
}

/**
 * Close the color editor
 */
function closeColorEditor() {
    state.editingColorId = null;
    document.getElementById('color-editor').classList.remove('visible');
}

// ============================================================================
// Sidebar Toggle and Resize
// ============================================================================

function toggleSidebar() {
    state.sidebarCollapsed = !state.sidebarCollapsed;
    const sidebar = document.getElementById('sidebar');
    const toggle = document.getElementById('sidebar-toggle');
    
    sidebar.classList.toggle('collapsed', state.sidebarCollapsed);
    toggle.textContent = state.sidebarCollapsed ? '▶' : '◀';
}

/**
 * Setup sidebar resize functionality
 */
function setupSidebarResize() {
    const handle = document.getElementById('sidebar-resize-handle');
    const sidebar = document.getElementById('sidebar');
    
    if (!handle || !sidebar) return;
    
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;
    
    handle.addEventListener('mousedown', (e) => {
        if (state.sidebarCollapsed) return;
        
        isResizing = true;
        startX = e.clientX;
        startWidth = sidebar.offsetWidth;
        
        handle.classList.add('resizing');
        document.body.style.cursor = 'ew-resize';
        document.body.style.userSelect = 'none';
        
        e.preventDefault();
    });
    
    document.addEventListener('mousemove', (e) => {
        if (!isResizing) return;
        
        const delta = e.clientX - startX;
        const newWidth = Math.max(250, Math.min(600, startWidth + delta));
        
        sidebar.style.width = `${newWidth}px`;
        sidebar.style.minWidth = `${newWidth}px`;
    });
    
    document.addEventListener('mouseup', () => {
        if (isResizing) {
            isResizing = false;
            handle.classList.remove('resizing');
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        }
    });
}

// ============================================================================
// Zoom Controls
// ============================================================================

function setZoom(zoom) {
    state.zoom = Math.max(0.25, Math.min(4, zoom));
    const svg = document.getElementById('hex-grid');
    svg.style.transform = `scale(${state.zoom})`;
    document.getElementById('zoom-level').textContent = `${Math.round(state.zoom * 100)}%`;
}

function zoomIn() {
    setZoom(state.zoom + 0.25);
}

function zoomOut() {
    setZoom(state.zoom - 0.25);
}

function zoomReset() {
    setZoom(1.0);
}

// ============================================================================
// Gradient Generation
// ============================================================================

/**
 * Generate gradient fill based on anchor points
 * Uses inverse-distance weighting to blend anchor colors in LAB color space,
 * then assigns closest available palette color (perceptual LAB distance) respecting quantities
 */
function generateGradient() {
    if (state.anchors.length < 2) {
        setStatus('Need at least 2 anchor points for gradient');
        return;
    }
    
    if (state.colors.length === 0) {
        setStatus('Add colors to palette first');
        return;
    }
    
    saveToHistory();
    
    console.time('Gradient generation');
    
    // Step 1: Calculate ideal color for each cell based on anchor distances
    const idealColors = [];
    
    for (let row = 0; row < state.rows; row++) {
        for (let col = 0; col < state.cols; col++) {
            const idx = gridIndex(row, col);
            
            // Calculate distances to each anchor
            const colorWeights = [];
            for (const anchor of state.anchors) {
                const colorObj = state.colors.find(c => c.id === anchor.colorId);
                if (!colorObj) continue;
                
                // Calculate hex grid distance (accounting for offset rows)
                const pos1 = hexToPixel(col, row, 1);
                const pos2 = hexToPixel(anchor.col, anchor.row, 1);
                const dist = Math.sqrt(Math.pow(pos1.x - pos2.x, 2) + Math.pow(pos1.y - pos2.y, 2));
                
                // Inverse square distance weighting for more localized gradients
                // Higher power = faster falloff = less influence from distant anchors
                const weight = 1 / (dist * dist + 0.01);
                colorWeights.push({ color: colorObj.color, weight });
            }
            
            let idealColor = blendColors(colorWeights);
            
            // Apply dither if enabled
            if (state.gradientDither && idealColor) {
                const rgb = hexToRgb(idealColor);
                if (rgb) {
                    const lab = rgbToLab(rgb.r, rgb.g, rgb.b);
                    
                    // Add random noise to LAB values (perceptually uniform)
                    // Scale noise by dither intensity
                    const noise = state.ditherIntensity;
                    lab.L += (Math.random() - 0.5) * noise * 2;
                    lab.a += (Math.random() - 0.5) * noise;
                    lab.b += (Math.random() - 0.5) * noise;
                    
                    // Clamp LAB values to valid ranges
                    lab.L = Math.max(0, Math.min(100, lab.L));
                    // a and b typically range -128 to 127, but we don't strictly clamp
                    
                    const ditheredRgb = labToRgb(lab.L, lab.a, lab.b);
                    idealColor = rgbToHex(ditheredRgb.r, ditheredRgb.g, ditheredRgb.b);
                }
            }
            
            idealColors.push({ row, col, idx, idealColor });
        }
    }
    
    // Step 2: Assign actual colors from palette, respecting quantities
    // Sort cells by how "certain" their color assignment is (furthest from ambiguity)
    // Then greedily assign colors
    
    // Track remaining quantities
    const remaining = {};
    for (const colorObj of state.colors) {
        remaining[colorObj.id] = colorObj.total;
    }
    
    // For each cell, find best matching available color
    // Process in order of distance from nearest anchor (most certain first)
    idealColors.sort((a, b) => {
        // Calculate min distance to any anchor for each cell
        const distA = Math.min(...state.anchors.map(anchor => {
            const pos1 = hexToPixel(a.col, a.row, 1);
            const pos2 = hexToPixel(anchor.col, anchor.row, 1);
            return Math.sqrt(Math.pow(pos1.x - pos2.x, 2) + Math.pow(pos1.y - pos2.y, 2));
        }));
        const distB = Math.min(...state.anchors.map(anchor => {
            const pos1 = hexToPixel(b.col, b.row, 1);
            const pos2 = hexToPixel(anchor.col, anchor.row, 1);
            return Math.sqrt(Math.pow(pos1.x - pos2.x, 2) + Math.pow(pos1.y - pos2.y, 2));
        }));
        return distA - distB;
    });
    
    // Assign colors
    for (const { row, col, idx, idealColor } of idealColors) {
        // Skip locked cells
        if (state.grid[idx].locked) {
            continue;
        }
        
        if (!idealColor) {
            state.grid[idx].color = null;
            state.grid[idx].colorId = null;
            continue;
        }
        
        // Find closest available color using perceptual LAB distance
        let bestColorId = null;
        let bestDistance = Infinity;
        
        for (const colorObj of state.colors) {
            if (remaining[colorObj.id] <= 0) continue;
            
            const dist = colorDistanceLab(idealColor, colorObj.color);
            if (dist < bestDistance) {
                bestDistance = dist;
                bestColorId = colorObj.id;
            }
        }
        
        if (bestColorId !== null) {
            const colorObj = state.colors.find(c => c.id === bestColorId);
            state.grid[idx].color = colorObj.color;
            state.grid[idx].colorId = bestColorId;
            remaining[bestColorId]--;
        } else {
            // No colors available, leave empty
            state.grid[idx].color = null;
            state.grid[idx].colorId = null;
        }
    }
    
    console.timeEnd('Gradient generation');
    
    renderGrid();
    updateColorCounts();
    setStatus(`Gradient generated from ${state.anchors.length} anchor points`);
}

// ============================================================================
// Event Handlers
// ============================================================================

function handleHexClick(row, col) {
    switch (state.tool) {
        case 'paint':
            handlePaint(row, col);
            break;
        case 'swap':
            handleSwap(row, col);
            break;
        case 'anchor':
            handleAnchor(row, col);
            break;
        case 'lock':
            handleLock(row, col);
            break;
        case 'erase':
            handleErase(row, col);
            break;
    }
}

function handlePaint(row, col, skipHistory = false) {
    if (state.selectedColorId === null) {
        setStatus('Select a color first');
        return false;
    }
    
    const colorObj = state.colors.find(c => c.id === state.selectedColorId);
    
    if (!skipHistory) {
        saveToHistory();
    }
    
    // Get all hexes in brush radius
    const hexes = getHexesInRadius(row, col, state.brushSize - 1);
    let painted = false;
    
    for (const { row: r, col: c } of hexes) {
        const cell = getCell(r, c);
        if (!cell) continue;
        
        // Skip if already this color
        if (cell.colorId === state.selectedColorId) continue;
        
        // Check if we have remaining quantity
        const currentUsage = countColorUsage(state.selectedColorId);
        if (currentUsage >= colorObj.total) {
            if (!painted) {
                setStatus(`No more ${colorObj.color} (#${colorObj.id}) available`);
            }
            break;
        }
        
        setCell(r, c, state.selectedColorId);
        painted = true;
    }
    
    if (painted) {
        renderGrid();
        updateColorCounts();
    }
    
    return painted;
}

function handleSwap(row, col) {
    if (state.swapSource === null) {
        // First click - select source
        state.swapSource = { row, col };
        renderGrid();
        setStatus('Click another hex to swap');
    } else {
        // Second click - perform swap
        const src = state.swapSource;
        const srcCell = getCell(src.row, src.col);
        const dstCell = getCell(row, col);
        
        // Don't swap with self
        if (src.row === row && src.col === col) {
            state.swapSource = null;
            renderGrid();
            setStatus('Swap cancelled');
            return;
        }
        
        saveToHistory();
        
        // Swap
        const srcData = { color: srcCell.color, colorId: srcCell.colorId };
        srcCell.color = dstCell.color;
        srcCell.colorId = dstCell.colorId;
        dstCell.color = srcData.color;
        dstCell.colorId = srcData.colorId;
        
        state.swapSource = null;
        renderGrid();
        setStatus('Hexes swapped');
    }
}

function handleAnchor(row, col) {
    if (state.selectedColorId === null) {
        setStatus('Select a color first');
        return;
    }
    
    // Check if anchor already exists at this position
    const existingIdx = state.anchors.findIndex(a => a.row === row && a.col === col);
    
    if (existingIdx !== -1) {
        // Toggle off if same color, update if different
        if (state.anchors[existingIdx].colorId === state.selectedColorId) {
            state.anchors.splice(existingIdx, 1);
            setStatus('Anchor removed');
        } else {
            state.anchors[existingIdx].colorId = state.selectedColorId;
            setStatus('Anchor updated');
        }
    } else {
        // Add new anchor
        state.anchors.push({ row, col, colorId: state.selectedColorId });
        setStatus(`Anchor added (${state.anchors.length} total)`);
    }
    
    renderGrid();
}

function handleLock(row, col) {
    const cell = getCell(row, col);
    
    saveToHistory();
    cell.locked = !cell.locked;
    
    renderGrid();
    setStatus(cell.locked ? 'Hex locked' : 'Hex unlocked');
}

function handleErase(row, col, skipHistory = false) {
    if (!skipHistory) {
        saveToHistory();
    }
    
    // Get all hexes in brush radius
    const hexes = getHexesInRadius(row, col, state.brushSize - 1);
    let erased = false;
    let anchorsErased = 0;
    
    for (const { row: r, col: c } of hexes) {
        const cell = getCell(r, c);
        if (!cell) continue;
        
        // Check if there's an anchor at this position
        const anchorIdx = state.anchors.findIndex(a => a.row === r && a.col === c);
        
        // Skip if nothing to erase
        if (cell.color === null && cell.colorId === null && anchorIdx === -1) {
            continue;
        }
        
        cell.color = null;
        cell.colorId = null;
        
        // Remove anchor if present
        if (anchorIdx !== -1) {
            state.anchors.splice(anchorIdx, 1);
            anchorsErased++;
        }
        
        erased = true;
    }
    
    if (erased) {
        renderGrid();
        updateColorCounts();
        if (!skipHistory) {
            if (anchorsErased > 0) {
                setStatus(`Erased hexes and ${anchorsErased} anchor${anchorsErased > 1 ? 's' : ''}`);
            } else {
                setStatus('Hexes erased');
            }
        }
    }
    
    return erased;
}

function setStatus(message) {
    document.getElementById('status-message').textContent = message;
}

/**
 * Update the tool hint text based on current tool
 */
function updateToolHint() {
    const hintEl = document.getElementById('tool-hint');
    if (!hintEl) return;
    
    const brushNote = state.brushSize > 1 ? ` (brush size: ${state.brushSize})` : '';
    
    const hints = {
        paint: `💡 Click or drag to paint${brushNote}`,
        swap: '🔄 Click two hexes to swap their colors',
        anchor: '📍 Click a hex to place an anchor for gradient',
        lock: '🔒 Click a hex to lock/unlock it (prevents gradient changes)',
        erase: `🧹 Click or drag to erase${brushNote}`
    };
    
    hintEl.textContent = hints[state.tool] || '💡 Select a tool and click hexes';
}

/**
 * Update mini brush button active state
 */
function updateMiniBrushButtons() {
    document.querySelectorAll('.btn-mini-brush').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.size) === state.brushSize);
    });
}

/**
 * Update mini brush selector visibility based on current tool
 */
function updateMiniBrushSelectorVisibility() {
    const brushSelector = document.getElementById('mini-brush-selector');
    if (state.tool === 'paint' || state.tool === 'erase') {
        brushSelector.classList.add('visible');
    } else {
        brushSelector.classList.remove('visible');
    }
}

/**
 * Update mini color selector selection state
 */
function updateMiniColorSelection() {
    document.querySelectorAll('.mini-color-item').forEach(el => {
        const colorId = parseInt(el.dataset.colorId);
        el.classList.toggle('selected', colorId === state.selectedColorId);
    });
}

// ============================================================================
// Export Functions
// ============================================================================

/**
 * Export grid as PNG image with options
 */
function exportPNG() {
    // Get export options
    const showGrid = document.getElementById('export-show-grid').checked;
    const showNumbers = document.getElementById('export-show-numbers').checked;
    const hideColors = document.getElementById('export-hide-colors').checked;
    
    // Create a clone of the SVG for export
    const svg = document.getElementById('hex-grid');
    const svgClone = svg.cloneNode(true);
    
    // Ensure proper SVG namespace (Firefox requirement)
    svgClone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    
    const hexes = svgClone.querySelectorAll('.hex');
    const anchorMarkers = svgClone.querySelectorAll('.anchor-marker');
    const lockIndicators = svgClone.querySelectorAll('.lock-indicator');
    
    // Apply hex styles
    hexes.forEach(hex => {
        if (hideColors) {
            // White fill
            hex.setAttribute('fill', '#ffffff');
        } else {
            // Keep the color fill
            const fill = hex.getAttribute('fill');
            if (fill && fill !== 'none') {
                hex.setAttribute('fill', fill);
            }
        }
        
        // Remove stroke from hexes (grid lines will be drawn separately if needed)
        hex.setAttribute('stroke', 'none');
    });
    
    // Add grid lines as separate elements in gaps between hexes
    if (showGrid) {
        const gridGroup = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        gridGroup.setAttribute('id', 'export-grid-lines');
        
        // Helper to check if a neighbor exists
        const hasNeighbor = (row, col) => {
            return row >= 0 && row < state.rows && col >= 0 && col < state.cols;
        };
        
        for (let row = 0; row < state.rows; row++) {
            for (let col = 0; col < state.cols; col++) {
                const { x, y } = hexToPixel(col, row, state.hexSize);
                const width = Math.sqrt(3) * state.hexSize;
                const height = state.hexSize;
                
                // Get neighbor positions based on odd/even row
                const isOddRow = row % 2 === 1;
                const neighbors = {
                    right: [row, col + 1],
                    left: [row, col - 1],
                    topRight: [row - 1, isOddRow ? col + 1 : col],
                    topLeft: [row - 1, isOddRow ? col : col - 1],
                    bottomRight: [row + 1, isOddRow ? col + 1 : col],
                    bottomLeft: [row + 1, isOddRow ? col : col - 1]
                };
                
                // Draw each edge only if there's no neighbor on that side (exterior)
                // OR if we're using the standard interior drawing pattern
                
                // Top-right edge
                if (!hasNeighbor(...neighbors.topRight)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x);
                    line.setAttribute('y1', y - height);
                    line.setAttribute('x2', x + width / 2);
                    line.setAttribute('y2', y - height / 2);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                // Right edge
                if (!hasNeighbor(...neighbors.right) || col < state.cols - 1) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x + width / 2);
                    line.setAttribute('y1', y - height / 2);
                    line.setAttribute('x2', x + width / 2);
                    line.setAttribute('y2', y + height / 2);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                // Bottom-right edge
                if (!hasNeighbor(...neighbors.bottomRight)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x + width / 2);
                    line.setAttribute('y1', y + height / 2);
                    line.setAttribute('x2', x);
                    line.setAttribute('y2', y + height);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                // Bottom-left edge
                if (!hasNeighbor(...neighbors.bottomLeft)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x);
                    line.setAttribute('y1', y + height);
                    line.setAttribute('x2', x - width / 2);
                    line.setAttribute('y2', y + height / 2);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                // Left edge
                if (!hasNeighbor(...neighbors.left)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x - width / 2);
                    line.setAttribute('y1', y + height / 2);
                    line.setAttribute('x2', x - width / 2);
                    line.setAttribute('y2', y - height / 2);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                // Top-left edge
                if (!hasNeighbor(...neighbors.topLeft)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x - width / 2);
                    line.setAttribute('y1', y - height / 2);
                    line.setAttribute('x2', x);
                    line.setAttribute('y2', y - height);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                // Interior lines: bottom-right and bottom-left (to avoid duplicates)
                if (hasNeighbor(...neighbors.bottomRight)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x + width / 2);
                    line.setAttribute('y1', y + height / 2);
                    line.setAttribute('x2', x);
                    line.setAttribute('y2', y + height);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
                
                if (hasNeighbor(...neighbors.bottomLeft)) {
                    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
                    line.setAttribute('x1', x);
                    line.setAttribute('y1', y + height);
                    line.setAttribute('x2', x - width / 2);
                    line.setAttribute('y2', y + height / 2);
                    line.setAttribute('stroke', '#000000');
                    line.setAttribute('stroke-width', '1');
                    gridGroup.appendChild(line);
                }
            }
        }
        
        svgClone.appendChild(gridGroup);
    }
    
    // Handle numbers - create them if they don't exist
    if (showNumbers) {
        // First, remove any existing numbers
        svgClone.querySelectorAll('.hex-number').forEach(num => num.remove());
        
        // Generate numbers for all colored cells
        for (let row = 0; row < state.rows; row++) {
            for (let col = 0; col < state.cols; col++) {
                const cell = getCell(row, col);
                if (!cell || !cell.colorId) continue;
                
                const { x, y } = hexToPixel(col, row, state.hexSize);
                const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
                text.setAttribute('x', x);
                text.setAttribute('y', y);
                text.setAttribute('text-anchor', 'middle');
                text.setAttribute('dominant-baseline', 'middle');
                text.setAttribute('font-family', 'JetBrains Mono, SF Mono, monospace');
                text.setAttribute('font-size', '10');
                text.setAttribute('font-weight', '500');
                text.setAttribute('pointer-events', 'none');
                
                // Set text color based on background
                if (hideColors) {
                    text.setAttribute('fill', '#000000');
                } else {
                    const textColor = isLightColor(cell.color) ? '#4a4540' : '#ffffff';
                    text.setAttribute('fill', textColor);
                }
                
                text.textContent = cell.colorId;
                svgClone.appendChild(text);
            }
        }
    } else {
        // Remove all numbers
        svgClone.querySelectorAll('.hex-number').forEach(num => num.remove());
    }
    
    // Remove anchor markers and lock indicators from export
    anchorMarkers.forEach(marker => marker.remove());
    lockIndicators.forEach(indicator => indicator.remove());
    
    // Create canvas
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    
    // Get SVG dimensions
    const width = parseInt(svg.getAttribute('width'));
    const height = parseInt(svg.getAttribute('height'));
    
    canvas.width = width * 2; // 2x resolution
    canvas.height = height * 2;
    ctx.scale(2, 2);
    
    // Draw white background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    
    // Convert SVG to image
    const svgData = new XMLSerializer().serializeToString(svgClone);
    const svgBlob = new Blob([svgData], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    
    const img = new Image();
    img.onload = function() {
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        
        // Download
        const link = document.createElement('a');
        link.download = 'hex-quilt-design.png';
        link.href = canvas.toDataURL('image/png');
        link.click();
        
        setStatus('PNG exported');
    };
    img.src = url;
}

/**
 * Export design to JSON file
 */
function exportToJSON() {
    const data = {
        version: '1.0',
        hexRealSize: state.hexRealSize,
        quiltWidth: state.quiltWidth,
        quiltHeight: state.quiltHeight,
        unit: state.unit,
        cols: state.cols,
        rows: state.rows,
        hexSize: state.hexSize,
        grid: state.grid,
        colors: state.colors,
        nextColorId: state.nextColorId,
        anchors: state.anchors,
        showNumbers: state.showNumbers
    };
    
    // Create JSON blob
    const jsonStr = JSON.stringify(data, null, 2);
    const blob = new Blob([jsonStr], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    
    // Download
    const link = document.createElement('a');
    link.download = 'hex-quilt-design.json';
    link.href = url;
    link.click();
    
    URL.revokeObjectURL(url);
    setStatus('Design exported');
}

/**
 * Import design from JSON file
 */
function importFromJSON(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
        try {
            const data = JSON.parse(event.target.result);
            
            // Validate basic structure
            if (!data.cols || !data.rows || !data.grid) {
                throw new Error('Invalid file format');
            }
            
            // Load the design
            state.hexRealSize = data.hexRealSize || 2;
            state.quiltWidth = data.quiltWidth || 30;
            state.quiltHeight = data.quiltHeight || 40;
            state.unit = data.unit || 'in';
            state.cols = data.cols;
            state.rows = data.rows;
            state.hexSize = data.hexSize;
            state.grid = data.grid;
            state.colors = data.colors || [];
            state.nextColorId = data.nextColorId || 1;
            state.anchors = data.anchors || [];
            state.showNumbers = data.showNumbers || false;
            
            // Update UI
            document.getElementById('hex-real-size').value = state.hexRealSize;
            document.getElementById('quilt-width').value = state.quiltWidth;
            document.getElementById('quilt-height').value = state.quiltHeight;
            document.getElementById('unit-select').value = state.unit;
            document.getElementById('unit-width').textContent = state.unit;
            document.getElementById('unit-height').textContent = state.unit;
            document.getElementById('show-numbers').checked = state.showNumbers;
            
            // Reset history
            state.history = [];
            state.historyIndex = -1;
            saveToHistory();
            
            // Update displays
            updateGridInfo();
            renderColorList();
            renderMiniColorSelector();
            renderGrid();
            updateColorCounts();
            updateToolHint();
            setStatus('Design imported');
        } catch (error) {
            console.error('Failed to import design:', error);
            setStatus('Failed to import design: ' + error.message);
        }
    };
    
    reader.readAsText(file);
    
    // Reset file input so the same file can be imported again if needed
    e.target.value = '';
}

/**
 * Save state to localStorage
 */
function saveState() {
    const data = {
        hexRealSize: state.hexRealSize,
        quiltWidth: state.quiltWidth,
        quiltHeight: state.quiltHeight,
        unit: state.unit,
        cols: state.cols,
        rows: state.rows,
        hexSize: state.hexSize,
        grid: state.grid,
        colors: state.colors,
        nextColorId: state.nextColorId,
        anchors: state.anchors,
        showNumbers: state.showNumbers
    };
    
    localStorage.setItem('hexQuiltDesigner', JSON.stringify(data));
    setStatus('Design saved to browser');
}

/**
 * Load state from localStorage
 */
function loadState() {
    const saved = localStorage.getItem('hexQuiltDesigner');
    if (!saved) {
        setStatus('No saved design found');
        return;
    }
    
    try {
        const data = JSON.parse(saved);
        
        state.hexRealSize = data.hexRealSize || 2;
        state.quiltWidth = data.quiltWidth || 30;
        state.quiltHeight = data.quiltHeight || 40;
        state.unit = data.unit || 'in';
        state.cols = data.cols;
        state.rows = data.rows;
        state.hexSize = data.hexSize;
        state.grid = data.grid;
        state.colors = data.colors;
        state.nextColorId = data.nextColorId;
        state.anchors = data.anchors || [];
        state.showNumbers = data.showNumbers || false;
        
        // Update UI
        document.getElementById('hex-real-size').value = state.hexRealSize;
        document.getElementById('quilt-width').value = state.quiltWidth;
        document.getElementById('quilt-height').value = state.quiltHeight;
        document.getElementById('unit-select').value = state.unit;
        document.getElementById('unit-width').textContent = state.unit;
        document.getElementById('unit-height').textContent = state.unit;
        document.getElementById('show-numbers').checked = state.showNumbers;
        
        // Reset history
        state.history = [];
        state.historyIndex = -1;
        saveToHistory();
        
        updateGridInfo();
        renderColorList();
        renderGrid();
        setStatus('Design loaded');
    } catch (e) {
        console.error('Failed to load state:', e);
        setStatus('Failed to load saved design');
    }
}

// ============================================================================
// Image Color Picker
// ============================================================================

/**
 * Open the image picker modal
 */
function openImagePicker() {
    const modal = document.getElementById('image-picker-modal');
    modal.classList.add('visible');
    resetImagePicker();
}

/**
 * Close the image picker modal
 */
function closeImagePicker() {
    const modal = document.getElementById('image-picker-modal');
    modal.classList.remove('visible');
    resetImagePicker();
}

/**
 * Reset the image picker state
 */
function resetImagePicker() {
    state.imagePicker.pickedColors = [];
    state.imagePicker.history = [[]]; // Initialize with empty state
    state.imagePicker.historyIndex = 0;
    state.imagePicker.imageData = null;
    
    document.getElementById('image-upload-area').style.display = 'flex';
    document.getElementById('image-canvas-container').style.display = 'none';
    document.getElementById('picked-colors-list').innerHTML = '';
    document.getElementById('picked-count').textContent = '0';
    updateImagePickerButtons();
}

/**
 * Handle image upload
 */
function handleImageUpload(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(event) {
        const img = new Image();
        img.onload = function() {
            const canvas = document.getElementById('image-picker-canvas');
            const ctx = canvas.getContext('2d');
            
            // Resize image if too large (max 800px width)
            const maxWidth = 800;
            let width = img.width;
            let height = img.height;
            
            if (width > maxWidth) {
                height = (height * maxWidth) / width;
                width = maxWidth;
            }
            
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            
            // Store image data
            state.imagePicker.imageData = ctx.getImageData(0, 0, width, height);
            
            // Show canvas, hide upload area
            document.getElementById('image-upload-area').style.display = 'none';
            document.getElementById('image-canvas-container').style.display = 'block';
        };
        img.src = event.target.result;
    };
    reader.readAsDataURL(file);
    
    // Reset file input
    e.target.value = '';
}

/**
 * Handle canvas click to pick color
 */
function handleCanvasClick(e) {
    if (!state.imagePicker.imageData) return;
    
    const canvas = document.getElementById('image-picker-canvas');
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((e.clientX - rect.left) * (canvas.width / rect.width));
    const y = Math.floor((e.clientY - rect.top) * (canvas.height / rect.height));
    
    // Get pixel color
    const index = (y * canvas.width + x) * 4;
    const data = state.imagePicker.imageData.data;
    const r = data[index];
    const g = data[index + 1];
    const b = data[index + 2];
    const color = rgbToHex(r, g, b);
    
    // Save to history (for undo/redo)
    saveImagePickerHistory();
    
    // Add color with default quantity
    state.imagePicker.pickedColors.push({ color, quantity: 20 });
    renderPickedColors();
    updateImagePickerButtons();
}

/**
 * Save image picker history for undo/redo
 */
function saveImagePickerHistory() {
    // Remove any future history if we're not at the end
    if (state.imagePicker.historyIndex < state.imagePicker.history.length - 1) {
        state.imagePicker.history = state.imagePicker.history.slice(0, state.imagePicker.historyIndex + 1);
    }
    
    // Save current state
    const snapshot = [...state.imagePicker.pickedColors];
    state.imagePicker.history.push(snapshot);
    state.imagePicker.historyIndex++;
    
    // Limit history
    if (state.imagePicker.history.length > 50) {
        state.imagePicker.history.shift();
        state.imagePicker.historyIndex--;
    }
}

/**
 * Undo image picker
 */
function undoImagePicker() {
    if (state.imagePicker.historyIndex > 0) {
        state.imagePicker.historyIndex--;
        state.imagePicker.pickedColors = [...state.imagePicker.history[state.imagePicker.historyIndex]];
        renderPickedColors();
        updateImagePickerButtons();
    }
}

/**
 * Redo image picker
 */
function redoImagePicker() {
    if (state.imagePicker.historyIndex < state.imagePicker.history.length - 1) {
        state.imagePicker.historyIndex++;
        state.imagePicker.pickedColors = [...state.imagePicker.history[state.imagePicker.historyIndex]];
        renderPickedColors();
        updateImagePickerButtons();
    }
}

/**
 * Render picked colors
 */
function renderPickedColors() {
    const list = document.getElementById('picked-colors-list');
    list.innerHTML = '';
    
    state.imagePicker.pickedColors.forEach((colorObj, index) => {
        const item = document.createElement('div');
        item.className = 'picked-color-item';
        
        const swatch = document.createElement('div');
        swatch.className = 'picked-color-swatch';
        swatch.style.backgroundColor = colorObj.color;
        swatch.title = colorObj.color;
        
        const qtyInput = document.createElement('input');
        qtyInput.type = 'number';
        qtyInput.className = 'picked-color-qty';
        qtyInput.value = colorObj.quantity;
        qtyInput.min = 1;
        qtyInput.addEventListener('input', (e) => {
            const value = parseInt(e.target.value);
            if (!isNaN(value) && value > 0) {
                state.imagePicker.pickedColors[index].quantity = value;
            }
        });
        
        item.appendChild(swatch);
        item.appendChild(qtyInput);
        list.appendChild(item);
    });
    
    document.getElementById('picked-count').textContent = state.imagePicker.pickedColors.length;
}

/**
 * Update image picker buttons (undo/redo)
 */
function updateImagePickerButtons() {
    document.getElementById('pick-undo').disabled = state.imagePicker.historyIndex <= 0;
    document.getElementById('pick-redo').disabled = state.imagePicker.historyIndex >= state.imagePicker.history.length - 1;
}

/**
 * Confirm and add picked colors to palette
 */
function confirmImagePicker() {
    const colors = state.imagePicker.pickedColors;
    if (colors.length === 0) {
        setStatus('No colors picked');
        return;
    }
    
    // Add each color to palette with specified quantity
    colors.forEach(colorObj => {
        addColor(colorObj.color, colorObj.quantity);
    });
    
    closeImagePicker();
    setStatus(`Added ${colors.length} color${colors.length > 1 ? 's' : ''} from image`);
}

// ============================================================================
// Initialization
// ============================================================================

function init() {
    // Sidebar toggle
    document.getElementById('sidebar-toggle').addEventListener('click', toggleSidebar);
    
    // Sidebar resize
    setupSidebarResize();
    
    // Zoom controls
    document.getElementById('zoom-in').addEventListener('click', zoomIn);
    document.getElementById('zoom-out').addEventListener('click', zoomOut);
    document.getElementById('zoom-reset').addEventListener('click', zoomReset);
    
    // Unit selector
    document.getElementById('unit-select').addEventListener('change', (e) => {
        state.unit = e.target.value;
        document.getElementById('unit-width').textContent = state.unit;
        document.getElementById('unit-height').textContent = state.unit;
        updateGridInfo();
    });
    
    // Update grid info when dimensions change
    ['hex-real-size', 'quilt-width', 'quilt-height'].forEach(id => {
        document.getElementById(id).addEventListener('input', updateGridInfo);
    });
    
    // Grid generation
    document.getElementById('generate-grid').addEventListener('click', () => {
        state.hexRealSize = parseFloat(document.getElementById('hex-real-size').value) || 2;
        state.quiltWidth = parseFloat(document.getElementById('quilt-width').value) || 30;
        state.quiltHeight = parseFloat(document.getElementById('quilt-height').value) || 40;
        
        // Calculate grid dimensions from real measurements
        const dims = calculateGridDimensions(state.hexRealSize, state.quiltWidth, state.quiltHeight);
        state.cols = dims.cols;
        state.rows = dims.rows;
        
        // Set display size based on a reasonable pixel density
        // Aim for hexes to be ~30-40px on screen
        state.hexSize = 30;
        
        initializeGrid();
        state.history = [];
        state.historyIndex = -1;
        saveToHistory();
        renderGrid();
        updateGridInfo();
        setStatus(`Generated ${state.cols}×${state.rows} grid (${state.grid.length} hexes)`);
    });
    
    // Color management
    document.getElementById('add-color').addEventListener('click', () => {
        const color = document.getElementById('new-color').value;
        const count = parseInt(document.getElementById('new-color-count').value) || 10;
        const newColor = addColor(color, count);
        // Auto-select the new color
        state.selectedColorId = newColor.id;
        renderColorList();
        setStatus(`Added color ${color} (${count} available)`);
    });
    
    // Image picker
    document.getElementById('pick-from-image').addEventListener('click', openImagePicker);
    document.getElementById('image-upload-btn').addEventListener('click', () => {
        document.getElementById('image-picker-file').click();
    });
    document.getElementById('image-picker-file').addEventListener('change', handleImageUpload);
    document.getElementById('image-picker-canvas').addEventListener('click', handleCanvasClick);
    document.getElementById('pick-undo').addEventListener('click', undoImagePicker);
    document.getElementById('pick-redo').addEventListener('click', redoImagePicker);
    document.getElementById('image-picker-ok').addEventListener('click', confirmImagePicker);
    document.getElementById('image-picker-cancel').addEventListener('click', closeImagePicker);
    document.getElementById('image-picker-close').addEventListener('click', closeImagePicker);
    
    document.getElementById('color-list').addEventListener('click', (e) => {
        // Handle remove button
        if (e.target.classList.contains('color-remove')) {
            e.stopPropagation();
            const colorId = parseInt(e.target.dataset.colorId);
            removeColor(colorId);
            return;
        }
        
        // Handle color selection
        const item = e.target.closest('.color-item');
        if (item) {
            const colorId = parseInt(item.dataset.colorId);
            state.selectedColorId = colorId;
            
            // Update selection UI
            document.querySelectorAll('.color-item').forEach(el => el.classList.remove('selected'));
            item.classList.add('selected');
            
            // Update mini color selector
            updateMiniColorSelection();
            
            // Open the color editor
            openColorEditor(colorId);
        }
    });
    
    // Mini color selector clicks
    document.getElementById('mini-color-selector').addEventListener('click', (e) => {
        const item = e.target.closest('.mini-color-item');
        if (item) {
            const colorId = parseInt(item.dataset.colorId);
            state.selectedColorId = colorId;
            
            // Update selection UI
            updateMiniColorSelection();
            setStatus(`Selected color #${colorId}`);
        }
    });
    
    // Color editor
    document.getElementById('editor-close').addEventListener('click', closeColorEditor);
    
    document.getElementById('editor-update').addEventListener('click', () => {
        if (state.editingColorId !== null) {
            const newQty = parseInt(document.getElementById('editor-qty').value) || 0;
            updateColorQuantity(state.editingColorId, newQty);
            setStatus(`Updated color #${state.editingColorId} quantity to ${newQty}`);
        }
    });
    
    // Allow Enter key to update quantity
    document.getElementById('editor-qty').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            document.getElementById('editor-update').click();
        }
    });
    
    // Display options
    document.getElementById('show-numbers').addEventListener('change', (e) => {
        state.showNumbers = e.target.checked;
        renderGrid();
    });
    
    // Gradient dither
    document.getElementById('gradient-dither').addEventListener('change', (e) => {
        state.gradientDither = e.target.checked;
        document.getElementById('dither-intensity').disabled = !e.target.checked;
        document.getElementById('dither-intensity-input').disabled = !e.target.checked;
    });
    
    document.getElementById('dither-intensity').addEventListener('input', (e) => {
        state.ditherIntensity = parseInt(e.target.value);
        document.getElementById('dither-intensity-input').value = state.ditherIntensity;
    });
    
    document.getElementById('dither-intensity-input').addEventListener('input', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value)) return;
        value = Math.max(0, Math.min(20, value));
        state.ditherIntensity = value;
        document.getElementById('dither-intensity').value = state.ditherIntensity;
    });
    
    // Brush size - slider
    document.getElementById('brush-size-slider').addEventListener('input', (e) => {
        state.brushSize = parseInt(e.target.value);
        document.getElementById('brush-size-input').value = state.brushSize;
        updateMiniBrushButtons();
        updateToolHint();
    });
    
    // Brush size - number input
    document.getElementById('brush-size-input').addEventListener('input', (e) => {
        let value = parseInt(e.target.value);
        if (isNaN(value)) return;
        // Clamp to range
        value = Math.max(1, Math.min(5, value));
        state.brushSize = value;
        document.getElementById('brush-size-slider').value = state.brushSize;
        updateMiniBrushButtons();
        updateToolHint();
    });
    
    // Brush size - mini buttons
    document.querySelectorAll('.btn-mini-brush').forEach(btn => {
        btn.addEventListener('click', () => {
            state.brushSize = parseInt(btn.dataset.size);
            document.getElementById('brush-size-slider').value = state.brushSize;
            document.getElementById('brush-size-input').value = state.brushSize;
            updateMiniBrushButtons();
            updateToolHint();
        });
    });
    
    // Tools (main sidebar)
    document.querySelectorAll('.btn-tool').forEach(btn => {
        btn.addEventListener('click', () => {
            state.tool = btn.dataset.tool;
            state.swapSource = null;
            
            document.querySelectorAll('.btn-tool').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            // Also update mini toolbar
            document.querySelectorAll('.mini-toolbar .btn-mini[data-tool]').forEach(b => {
                b.classList.toggle('active', b.dataset.tool === state.tool);
            });
            
            // Update brush selector visibility
            updateMiniBrushSelectorVisibility();
            
            // Update tool hint
            updateToolHint();
            
            renderGrid();
            setStatus(`${state.tool.charAt(0).toUpperCase() + state.tool.slice(1)} tool selected`);
        });
    });
    
    // Mini toolbar tools
    document.querySelectorAll('.mini-toolbar .btn-mini[data-tool]').forEach(btn => {
        btn.addEventListener('click', () => {
            state.tool = btn.dataset.tool;
            state.swapSource = null;
            
            // Update mini toolbar
            document.querySelectorAll('.mini-toolbar .btn-mini[data-tool]').forEach(b => {
                b.classList.toggle('active', b.dataset.tool === state.tool);
            });
            
            // Update brush selector visibility
            updateMiniBrushSelectorVisibility();
            
            // Also update main toolbar
            document.querySelectorAll('.btn-tool').forEach(b => {
                b.classList.toggle('active', b.dataset.tool === state.tool);
            });
            
            // Update tool hint
            updateToolHint();
            
            renderGrid();
        });
    });
    
    // Mini toolbar undo/redo
    document.getElementById('mini-undo').addEventListener('click', undo);
    document.getElementById('mini-redo').addEventListener('click', redo);
    
    // Gradient generation
    document.getElementById('generate-gradient').addEventListener('click', generateGradient);
    
    document.getElementById('clear-anchors').addEventListener('click', () => {
        state.anchors = [];
        renderGrid();
        setStatus('Anchors cleared');
    });
    
    document.getElementById('clear-grid').addEventListener('click', () => {
        if (confirm('Clear entire grid?')) {
            saveToHistory();
            for (const cell of state.grid) {
                cell.color = null;
                cell.colorId = null;
            }
            state.anchors = [];
            renderGrid();
            updateColorCounts();
            setStatus('Grid cleared');
        }
    });
    
    // History
    document.getElementById('undo').addEventListener('click', undo);
    document.getElementById('redo').addEventListener('click', redo);
    
    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'z' && (e.ctrlKey || e.metaKey)) {
            if (e.shiftKey) {
                redo();
            } else {
                undo();
            }
            e.preventDefault();
        }
    });
    
    // Export/Save/Load
    document.getElementById('export-png').addEventListener('click', exportPNG);
    document.getElementById('export-json').addEventListener('click', exportToJSON);
    document.getElementById('import-json').addEventListener('click', () => {
        document.getElementById('import-file').click();
    });
    document.getElementById('import-file').addEventListener('change', importFromJSON);
    document.getElementById('save-state').addEventListener('click', saveState);
    document.getElementById('load-state').addEventListener('click', loadState);
    
    // Hex grid interactions
    const hexGrid = document.getElementById('hex-grid');
    
    // Click handler
    hexGrid.addEventListener('click', (e) => {
        const hex = e.target.closest('.hex');
        if (hex) {
            const row = parseInt(hex.dataset.row);
            const col = parseInt(hex.dataset.col);
            handleHexClick(row, col);
        }
    });
    
    // Mouse down - start dragging for paint/erase
    hexGrid.addEventListener('mousedown', (e) => {
        const hex = e.target.closest('.hex');
        if (hex && (state.tool === 'paint' || state.tool === 'erase')) {
            state.isDragging = true;
            state.dragAction = state.tool;
            
            // Save history once at the start of the drag
            saveToHistory();
            
            const row = parseInt(hex.dataset.row);
            const col = parseInt(hex.dataset.col);
            
            // Apply the action (skip history since we saved already)
            if (state.tool === 'paint') {
                handlePaint(row, col, true);
            } else if (state.tool === 'erase') {
                handleErase(row, col, true);
            }
            
            e.preventDefault();
        }
    });
    
    // Mouse over - continue painting/erasing while dragging
    hexGrid.addEventListener('mouseover', (e) => {
        if (state.isDragging && state.dragAction) {
            const hex = e.target.closest('.hex');
            if (hex) {
                const row = parseInt(hex.dataset.row);
                const col = parseInt(hex.dataset.col);
                
                if (state.dragAction === 'paint') {
                    handlePaint(row, col, true);
                } else if (state.dragAction === 'erase') {
                    handleErase(row, col, true);
                }
            }
        }
    });
    
    // Mouse up - stop dragging
    document.addEventListener('mouseup', () => {
        if (state.isDragging) {
            state.isDragging = false;
            state.dragAction = null;
            
            // Update status after drag complete
            if (state.tool === 'paint') {
                setStatus('Painted hexes');
            } else if (state.tool === 'erase') {
                setStatus('Erased hexes');
            }
        }
    });
    
    // Mouse leave - stop dragging if mouse leaves the grid
    hexGrid.addEventListener('mouseleave', () => {
        if (state.isDragging) {
            state.isDragging = false;
            state.dragAction = null;
        }
    });
    
    // Initial setup
    updateGridInfo();
    
    // Generate initial grid
    const dims = calculateGridDimensions(state.hexRealSize, state.quiltWidth, state.quiltHeight);
    state.cols = dims.cols;
    state.rows = dims.rows;
    state.hexSize = 30;
    
    initializeGrid();
    saveToHistory();
    renderGrid();
    updateMiniBrushSelectorVisibility();
}

// Start the app
document.addEventListener('DOMContentLoaded', init);
