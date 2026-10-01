const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

/**
 * Computes 64-bit DCT perceptual hash (pHash).
 * 1. Grayscale & resize to 32x32.
 * 2. 2D DCT on 32x32 values.
 * 3. Extract top-left 8x8 low-frequency coefficients (ignoring DC at (0,0)).
 * 4. Compute median of the 64 coefficients.
 * 5. Bit is 1 if coeff > median, else 0.
 * 6. Returns 64-bit binary string and 16-character hexadecimal representation.
 */
async function computePHash(imageBuffer) {
    const size = 32;
    const { data } = await sharp(imageBuffer)
        .grayscale()
        .resize(size, size, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

    const matrix = Array.from({ length: size }, (_, y) =>
        Array.from({ length: size }, (_, x) => data[y * size + x])
    );

    const dct = Array.from({ length: 8 }, () => Array(8).fill(0));
    for (let u = 0; u < 8; u++) {
        for (let v = 0; v < 8; v++) {
            let sum = 0;
            for (let x = 0; x < size; x++) {
                for (let y = 0; y < size; y++) {
                    sum += matrix[y][x] *
                        Math.cos(((2 * x + 1) * u * Math.PI) / (2 * size)) *
                        Math.cos(((2 * y + 1) * v * Math.PI) / (2 * size));
                }
            }
            const cu = u === 0 ? 1 / Math.SQRT2 : 1;
            const cv = v === 0 ? 1 / Math.SQRT2 : 1;
            dct[v][u] = (1 / 4) * cu * cv * sum;
        }
    }

    const vals = [];
    for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
            if (u === 0 && v === 0) continue;
            vals.push(dct[v][u]);
        }
    }
    vals.sort((a, b) => a - b);
    const median = (vals[Math.floor(vals.length / 2)] + vals[Math.floor((vals.length - 1) / 2)]) / 2;

    let binary = '';
    for (let v = 0; v < 8; v++) {
        for (let u = 0; u < 8; u++) {
            binary += dct[v][u] > median ? '1' : '0';
        }
    }

    const hex = binaryToHex(binary);
    return { binary, hex };
}

/**
 * Computes 64-bit difference hash (dHash).
 * 1. Grayscale & resize to 9x8.
 * 2. Compare pixel(x, y) > pixel(x+1, y).
 * 3. Returns 64-bit binary string and 16-character hexadecimal representation.
 */
async function computeDHash(imageBuffer) {
    const { data } = await sharp(imageBuffer)
        .grayscale()
        .resize(9, 8, { fit: 'fill' })
        .raw()
        .toBuffer({ resolveWithObject: true });

    let binary = '';
    for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
            const left = data[y * 9 + x];
            const right = data[y * 9 + x + 1];
            binary += left > right ? '1' : '0';
        }
    }

    const hex = binaryToHex(binary);
    return { binary, hex };
}

function binaryToHex(binary) {
    let hex = '';
    for (let i = 0; i < binary.length; i += 4) {
        const nibble = binary.slice(i, i + 4);
        hex += parseInt(nibble, 2).toString(16);
    }
    return hex.padStart(16, '0');
}

function hexToBinary(hex) {
    let binary = '';
    const cleanHex = hex.trim().replace(/^0x/i, '');
    for (let i = 0; i < cleanHex.length; i++) {
        const binNibble = parseInt(cleanHex[i], 16).toString(2).padStart(4, '0');
        binary += binNibble;
    }
    return binary;
}

function hammingDistance(h1, h2) {
    const bin1 = h1.length === 64 && /^[01]+$/.test(h1) ? h1 : hexToBinary(h1);
    const bin2 = h2.length === 64 && /^[01]+$/.test(h2) ? h2 : hexToBinary(h2);

    const minLen = Math.min(bin1.length, bin2.length);
    let dist = Math.abs(bin1.length - bin2.length);
    for (let i = 0; i < minLen; i++) {
        if (bin1[i] !== bin2[i]) dist++;
    }
    return dist;
}

module.exports = {
    computePHash,
    computeDHash,
    binaryToHex,
    hexToBinary,
    hammingDistance,
};
