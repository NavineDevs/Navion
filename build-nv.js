const { build } = require('esbuild');
const { readFileSync, writeFileSync } = require('fs');

const pkg = JSON.parse(readFileSync('package.json'));
process.env.NAVION_VERSION = pkg.version || '4.0.0';

build({
    platform: 'browser',
    sourcemap: false,
    minify: true,
    entryPoints: {
        'nv.bundle': './nv-src/rewrite/index.js',
        'nv.client': './nv-src/client/index.js',
        'nv.handler': './nv-src/uv.handler.js',
        'nv.sw': './nv-src/uv.sw.js',
    },
    define: {
        'process.env.ULTRAVIOLET_VERSION': JSON.stringify(process.env.NAVION_VERSION),
        'process.env.ULTRAVIOLET_COMMIT_HASH': JSON.stringify('navion-v4'),
    },
    bundle: true,
    treeShaking: true,
    logLevel: 'info',
    outdir: 'public/',
}).then(() => {
    console.log('[NAVION] Build complete! Generated nv.bundle.js, nv.client.js, nv.handler.js, nv.sw.js');
}).catch((err) => {
    console.error('[NAVION] Build failed:', err);
    process.exit(1);
});
