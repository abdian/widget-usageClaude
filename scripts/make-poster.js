'use strict';

/**
 * Renders assets/poster.html to assets/poster.png through Electron, so the banner
 * is drawn by the same engine and the same tokens as the app itself.
 *
 * Run with: npm run poster
 */

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, screen } = require('electron');

const WIDTH = 1280;
const HEIGHT = 640;

app.disableHardwareAcceleration();

// On a scaled display, CSS pixels and device pixels differ and the capture comes
// out cropped and magnified. Pinning the scale factor makes the poster render at
// exactly the size it is written in, whatever machine builds it.
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.commandLine.appendSwitch('high-dpi-support', '1');

app.whenReady().then(async () => {
  // An offscreen window takes its size in physical pixels, so the capture is
  // WIDTH x HEIGHT regardless of display scaling. The CSS viewport inside it,
  // though, is that divided by the device pixel ratio — so the poster is scaled
  // to fit it below rather than assuming the two agree.
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    useContentSize: true,
    show: false,
    webPreferences: { offscreen: true },
  });

  await win.loadFile(path.join(__dirname, '..', 'assets', 'poster.html'));

  // Offscreen rendering needs a beat after load before the first frame is complete.
  await new Promise((resolve) => setTimeout(resolve, 1200));

  const metrics = await win.webContents.executeJavaScript(
    '({ w: document.body.scrollWidth, h: document.body.scrollHeight,' +
      ' vw: window.innerWidth, vh: window.innerHeight, dpr: window.devicePixelRatio })'
  );
  console.log('layout', JSON.stringify(metrics));

  // Fit the poster's own 1280x640 layout into the viewport we actually got. The
  // physical capture still lands on 1280x640 because viewport x dpr = window size.
  const fit = metrics.vw / metrics.w;
  if (Math.abs(fit - 1) > 0.001) {
    await win.webContents.executeJavaScript(
      `document.documentElement.style.zoom = ${fit}; document.body.style.zoom = 1;`
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  const image = await win.webContents.capturePage();

  const out = path.join(__dirname, '..', 'assets', 'poster.png');
  fs.writeFileSync(out, image.toPNG());
  console.log(`Wrote assets/poster.png (${image.getSize().width}x${image.getSize().height})`);

  app.quit();
});
