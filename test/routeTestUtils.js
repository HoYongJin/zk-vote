function invokeJson(router, { method = "POST", url = "/", params = {}, body = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = {
            method,
            url,
            originalUrl: url,
            baseUrl: "",
            path: url,
            params,
            body,
            headers: {
                "content-type": "application/json",
            },
        };

        const res = {
            statusCode: 200,
            status(code) {
                this.statusCode = code;
                return this;
            },
            json(payload) {
                resolve({ status: this.statusCode, body: payload });
                return this;
            },
            send(payload) {
                resolve({ status: this.statusCode, body: payload });
                return this;
            },
            setHeader() {},
            getHeader() {},
            end(payload) {
                resolve({ status: this.statusCode, body: payload });
            },
        };

        router.handle(req, res, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve({ status: 404, body: null });
            }
        });
    });
}

function withMockedModule(modulePath, exportsValue) {
    const resolved = require.resolve(modulePath);
    const previous = require.cache[resolved];
    require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: exportsValue,
    };
    return () => {
        if (previous) {
            require.cache[resolved] = previous;
        } else {
            delete require.cache[resolved];
        }
    };
}

module.exports = {
    invokeJson,
    withMockedModule,
};
