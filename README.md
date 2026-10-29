# OpenCON

OpenCON is a web-based, client-side Xbox package and disc-image explorer.

Supported package families:

- Standard STFS file-table packages signed as `CON`, `LIVE`, or `PIRS`
- Split Games on Demand / SVOD packages (header plus `.data/Data0000`, `Data0001`, …)
- Monolithic Xbox App / XUP-style PIRS files containing the 0xB000-byte header followed by SVOD fragments
- XDVDFS browsing and streamed file extraction from GoD/SVOD packages
- Filesystem-only XISO images and full XGD1, XGD2, and XGD3 disc images

## Privacy

All parsing occurs in the browser. OpenCON has no analytics, network requests, package upload code, or external JavaScript dependencies.

## License

OpenCON is available under the [MIT License](LICENSE).
