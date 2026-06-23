(function() {
    'use strict';

    const DEFAULT_BASE_PATH = '/static/lottie/';
    const _instances = new Set();

    function _resolveContainer(container) {
        if (!container) return null;
        if (typeof container === 'string') return document.querySelector(container);
        if (container instanceof Element) return container;
        return null;
    }

    function _resolveAnimationOptions(options) {
        const opts = options || {};
        if (opts.animationData) return { animationData: opts.animationData };
        if (opts.path) return { path: String(opts.path) };
        if (opts.defaultName) {
            const safe = String(opts.defaultName).replace(/[^a-zA-Z0-9._-]/g, '').replace(/\.json$/i, '');
            if (safe) return { path: `${DEFAULT_BASE_PATH}${safe}.json` };
        }
        return { path: `${DEFAULT_BASE_PATH}spinner.json` };
    }

    function _isAvailable() {
        return !!(window.lottie && typeof window.lottie.loadAnimation === 'function');
    }

    window.feedBackLottie = {
        isAvailable: _isAvailable,
        defaults: {
            basePath: DEFAULT_BASE_PATH,
            spinner: `${DEFAULT_BASE_PATH}spinner.json`,
        },
        create(container, options) {
            if (!_isAvailable()) {
                console.warn('[lottie] window.lottie is not available');
                return null;
            }

            const root = _resolveContainer(container);
            if (!root) {
                console.warn('[lottie] invalid container');
                return null;
            }

            const animationSource = _resolveAnimationOptions(options);
            const opts = options || {};
            const instance = window.lottie.loadAnimation({
                container: root,
                renderer: opts.renderer || 'svg',
                loop: opts.loop !== false,
                autoplay: opts.autoplay !== false,
                name: opts.name || undefined,
                ...animationSource,
                rendererSettings: {
                    preserveAspectRatio: 'xMidYMid meet',
                    ...(opts.rendererSettings || {}),
                },
            });
            _instances.add(instance);
            return instance;
        },
        destroy(instance) {
            if (!instance) return;
            try { instance.destroy(); } catch (e) { /* ignore */ }
            _instances.delete(instance);
        },
        destroyAll() {
            for (const instance of _instances) {
                try { instance.destroy(); } catch (e) { /* ignore */ }
            }
            _instances.clear();
        },
    };
})();
