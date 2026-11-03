# Read-along OCR runtime

Files used by `scripts/reading/read-along-ocr.mts` to find and read the text
in comic pages inside the app.

| File | From | License |
|---|---|---|
| `ort.wasm.bundle.min.mjs`, `ort-wasm-simd-threaded.wasm` | [onnxruntime-web](https://www.npmjs.com/package/onnxruntime-web) 1.31.1 (CPU/WASM build only) | MIT, © Microsoft Corporation |
| `ppocrv6-dict.txt` | Character list embedded in PaddleOCR's PP-OCRv6 recognition model | Apache-2.0, © PaddlePaddle Authors |
| `ocr-frame.html` | OpenComic | GPL-3.0 |

The models themselves (PP-OCRv6 small detection + recognition, ONNX exports
by RapidAI) are not bundled: they download on first use from ModelScope and
are checked against their SHA-256.
