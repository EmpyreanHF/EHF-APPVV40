// =====================================================
        // FIREBASE — use globals set by head initialization
        // =====================================================
        // Re-attempt init in case SDK loaded after head script ran
        if (!window._firebaseLoaded && typeof firebase !== 'undefined') {
            window._initFirebase();
        }
        // Local aliases that always point to working implementations
        let fbAuth    = window.fbAuth;
        let fbDb      = window.fbDb;
        let fbStorage = window.fbStorage;
        // Keep them in sync if Firebase loads asynchronously
        Object.defineProperty(window, 'fbAuth',    { get: () => fbAuth,    set: v => { fbAuth = v; },    configurable: true });
        Object.defineProperty(window, 'fbDb',      { get: () => fbDb,      set: v => { fbDb = v; },      configurable: true });
        Object.defineProperty(window, 'fbStorage', { get: () => fbStorage, set: v => { fbStorage = v; }, configurable: true });

        function _serverTimestamp() {
            try {
                if (typeof firebase !== 'undefined' && firebase.firestore && firebase.firestore.FieldValue)
                    return firebase.firestore.FieldValue.serverTimestamp();
            } catch(e) {}
            return new Date();
        }

        // =====================================================
        // CLOUDINARY CONFIG (Primary media storage)
        // ─────────────────────────────────────────────────────
        // These are PUBLIC frontend credentials — the cloud name
        // and unsigned upload preset are safe to hardcode here.
        // DO NOT make this depend on /api/config: if that request
        // is slow or missing, uploads fail for every user.
        // =====================================================
        const CLOUDINARY_CLOUD      = 'dxcthrgsp';
        const CLOUDINARY_PRESET     = 'Empyrean_preset';  // must match Cloudinary dashboard exactly
        const CLOUDINARY_URL_IMAGE  = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/image/upload';
        const CLOUDINARY_URL_VIDEO  = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/video/upload';
        const CLOUDINARY_URL_AUTO   = 'https://api.cloudinary.com/v1_1/' + CLOUDINARY_CLOUD + '/auto/upload';
        // Helper: pick correct endpoint so Cloudinary never rejects a type mismatch
        function _cloudinaryEndpoint(file) {
            if (!file || typeof file === 'string') return CLOUDINARY_URL_AUTO;
            if (file.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/i.test(file.name)) return CLOUDINARY_URL_VIDEO;
            if (file.type.startsWith('image/') || /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(file.name)) return CLOUDINARY_URL_IMAGE;
            return CLOUDINARY_URL_AUTO;
        }
        // Legacy alias so any code referencing CLOUDINARY_URL still works
        const CLOUDINARY_URL = CLOUDINARY_URL_AUTO;

        // ── PRESET SANITY CHECK (runs once on page load) ──────
        // Verifies the upload preset exists & is UNSIGNED.
        // If Cloudinary returns 400 with "Upload preset not found"
        // or "must use signed" you will see it in the console.
        (function _verifyCloudinaryPreset() {
            var testXhr = new XMLHttpRequest();
            testXhr.open('POST', CLOUDINARY_URL, true);
            testXhr.timeout = 15000;
            testXhr.onload = function() {
                if (testXhr.status === 200) {
                    console.info('[Cloudinary] ✅ Preset "' + CLOUDINARY_PRESET + '" verified — unsigned uploads working.');
                } else {
                    try {
                        var err = JSON.parse(testXhr.responseText);
                        console.error('[Cloudinary] ❌ Preset check failed (' + testXhr.status + '):', err.error && err.error.message);
                        console.error('[Cloudinary]    → Go to Cloudinary Dashboard → Settings → Upload → Upload Presets');
                        console.error('[Cloudinary]    → Make sure "' + CLOUDINARY_PRESET + '" exists and is set to UNSIGNED mode.');
                    } catch(e) {
                        console.error('[Cloudinary] ❌ Preset check HTTP ' + testXhr.status);
                    }
                }
            };
            testXhr.onerror = function() {
                console.warn('[Cloudinary] Preset check skipped — network unavailable (upload will retry when user posts).');
            };
            // Send a tiny 1×1 transparent GIF as the test payload
            var tinyGifB64 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAEALAAAAAABAAEAAAICRAEAOw==';
            var byteStr = atob(tinyGifB64);
            var arr = new Uint8Array(byteStr.length);
            for (var i = 0; i < byteStr.length; i++) arr[i] = byteStr.charCodeAt(i);
            var testBlob = new Blob([arr], { type: 'image/gif' });
            var testFile = new File([testBlob], '_empyrean_preset_check.gif', { type: 'image/gif' });
            var fd = new FormData();
            fd.append('file', testFile);
            fd.append('upload_preset', CLOUDINARY_PRESET);
            fd.append('tags', 'empyrean_preset_check');
            testXhr.send(fd);
        })();

        // Expose uploadToCloudinary globally so secondary scripts can call it.
        // CRITICAL RULE: This function MUST either resolve with a real
        // https://res.cloudinary.com/... URL or reject.  It must NEVER
        // resolve with a blob:// URL — those are tab-local and invisible
        // to every other device/user when stored in Firestore.
        window.uploadToCloudinary = async function uploadToCloudinary(file, onProgress, _retryCount) {
            // If already a URL string (e.g. existing post being re-saved), pass through unchanged
            if (!file || !(file instanceof File)) {
                if (typeof file === 'string') return file;
                return Promise.reject(new Error('uploadToCloudinary: invalid argument — expected a File'));
            }

            // Detect video files — give them a much longer timeout on Lagos networks
            var _isVideoFile = file.type.startsWith('video/') || /\.(mp4|webm|mov|avi|mkv)$/i.test(file.name);
            // Images: 90s; Videos: 3 minutes (180s) to handle large files on 4G/5G
            var UPLOAD_TIMEOUT_MS = _isVideoFile ? 180000 : 90000;
            // Use the correct Cloudinary endpoint for this file type
            var _uploadUrl = _cloudinaryEndpoint(file);

            var _retry = typeof _retryCount === 'number' ? _retryCount : 0;

            return new Promise((resolve, reject) => {
                const timeoutId = setTimeout(() => {
                    xhr.abort();
                    const msg = (_isVideoFile ? 'Video upload' : 'Upload') + ' timed out after ' + (UPLOAD_TIMEOUT_MS/1000) + 's. Check connection and try again.';
                    console.warn('[Cloudinary] ⏱ ' + msg);
                    if (typeof showNotification === 'function') showNotification(msg, 'error');
                    reject(new Error('Upload timed out'));
                }, UPLOAD_TIMEOUT_MS);

                const fd = new FormData();
                fd.append('file', file);
                fd.append('upload_preset', CLOUDINARY_PRESET);
                fd.append('tags', 'empyrean_app');
                // NOTE: resource_type must be in the URL path (handled by _uploadUrl), NOT in FormData

                const xhr = new XMLHttpRequest();
                xhr.open('POST', _uploadUrl, true);
                xhr.timeout = UPLOAD_TIMEOUT_MS;

                xhr.upload.onprogress = (e) => {
                    if (e.lengthComputable) {
                        const pct = Math.round((e.loaded / e.total) * 100);
                        if (onProgress) onProgress(pct);
                        document.querySelectorAll('.upload-progress-bar').forEach(bar => {
                            bar.style.width = pct + '%';
                            bar.style.background = 'linear-gradient(90deg,#00897B,#4CAF50)';
                        });
                    }
                };

                xhr.onload = () => {
                    clearTimeout(timeoutId);
                    if (xhr.status === 200) {
                        let res;
                        try { res = JSON.parse(xhr.responseText); }
                        catch (e) {
                            console.error('[Cloudinary] ❌ Could not parse response JSON:', e);
                            return reject(new Error('Cloudinary response was not valid JSON'));
                        }
                        if (!res.secure_url) {
                            // Cloudinary returned 200 but no URL — very unusual; log the full response
                            console.error('[Cloudinary] ❌ Response missing secure_url. Full response:', res);
                            return reject(new Error('Cloudinary returned 200 but no secure_url'));
                        }
                        console.info('[Cloudinary] ✅ Upload successful:', {
                            public_id: res.public_id,
                            format: res.format,
                            size_kb: Math.round((res.bytes || 0) / 1024),
                            url: res.secure_url.substring(0, 80) + '...'
                        });
                        window._cloudinaryUploads = (window._cloudinaryUploads || 0) + 1;
                        resolve(res.secure_url);
                    } else {
                        // Log the full error body so the root cause is visible in the console
                        let errMsg = 'HTTP ' + xhr.status;
                        try {
                            const errBody = JSON.parse(xhr.responseText);
                            errMsg += ' — ' + (errBody.error && errBody.error.message || xhr.responseText);
                            // Common actionable errors:
                            if (xhr.status === 400 && errMsg.includes('preset')) {
                                console.error('[Cloudinary] ❌ Upload preset error. Go to Cloudinary Dashboard → Settings → Upload → Upload Presets and verify "' + CLOUDINARY_PRESET + '" exists and is UNSIGNED.');
                            } else if (xhr.status === 401) {
                                console.error('[Cloudinary] ❌ Unauthorized. The preset "' + CLOUDINARY_PRESET + '" may be set to SIGNED mode. Switch it to UNSIGNED in your Cloudinary dashboard.');
                            }
                        } catch(e) { /* non-JSON error body, use status only */ }
                        console.error('[Cloudinary] ❌ Upload failed:', errMsg);
                        if (typeof showNotification === 'function') showNotification('Media upload failed: ' + errMsg, 'error');
                        reject(new Error('Cloudinary upload failed: ' + errMsg));
                    }
                };

                xhr.onerror = () => {
                    clearTimeout(timeoutId);
                    console.error('[Cloudinary] ❌ Network error — XHR onerror fired.');
                    if (_retry < 2) {
                        // Auto-retry up to 2 times with increasing delay (1.5s, 3s)
                        var _retryDelay = (_retry + 1) * 1500;
                        console.warn('[Cloudinary] ⟳ Retry ' + (_retry + 1) + '/2 in ' + _retryDelay + 'ms…');
                        if (typeof showNotification === 'function')
                            showNotification('Upload interrupted — retrying (' + (_retry + 1) + '/2)…', 'warning');
                        setTimeout(function() {
                            window.uploadToCloudinary(file, onProgress, _retry + 1).then(resolve).catch(reject);
                        }, _retryDelay);
                    } else {
                        if (typeof showNotification === 'function')
                            showNotification('Upload failed after 3 attempts. Check your connection.', 'error');
                        reject(new Error('Network error — could not reach Cloudinary after retries'));
                    }
                };
                xhr.ontimeout = () => {
                    clearTimeout(timeoutId);
                    if (_retry < 1) {
                        console.warn('[Cloudinary] ⟳ Timeout — retrying once…');
                        if (typeof showNotification === 'function')
                            showNotification('Upload timed out — retrying once…', 'warning');
                        setTimeout(function() {
                            window.uploadToCloudinary(file, onProgress, _retry + 1).then(resolve).catch(reject);
                        }, 2000);
                    } else {
                        reject(new Error('XHR timed out during upload — even after retry'));
                    }
                };

                xhr.send(fd);
            });
        };
        const uploadToCloudinary = window.uploadToCloudinary;

        async function uploadMediaFilesToCloudinary(files, onProgress) {
            if (!files || files.length === 0) return [];
            const uploads = Array.from(files).map(async (file, idx) => {
                // Already a URL string (e.g. existing media being re-saved)
                if (typeof file === 'string') {
                    if (file.startsWith('blob:')) {
                        // Blob URLs stored from a previous bug — reject so the post is blocked
                        console.error('[uploadMedia] ❌ Refusing to re-save a blob:// URL — this file was never actually uploaded to Cloudinary.');
                        throw new Error('Media was not properly uploaded. Please re-attach the file and try again.');
                    }
                    return file;
                }
                // Non-File object with a cached cloud URL
                if (!(file instanceof File)) {
                    const cached = file._cloudUrl || file.url || '';
                    if (cached.startsWith('blob:')) {
                        throw new Error('Cached media URL is a blob — re-attach the file and try again.');
                    }
                    return cached;
                }
                // Validate file size (max 100 MB)
                if (file.size > 100 * 1024 * 1024) {
                    const msg = '"' + file.name + '" is too large (max 100 MB).';
                    if (typeof showNotification === 'function') showNotification(msg, 'error');
                    throw new Error(msg);
                }
                try {
                    const url = await uploadToCloudinary(file, (pct) => {
                        if (onProgress) onProgress(idx, pct);
                    });
                    // url is guaranteed to be https://res.cloudinary.com/... at this point
                    file._cloudUrl = url;
                    return url;
                } catch(err) {
                    console.error('[uploadMedia] ❌ Upload failed for "' + file.name + '":', err.message);
                    if (typeof showNotification === 'function')
                        showNotification('Upload failed for "' + file.name + '": ' + err.message, 'error');
                    throw err; // re-throw — never silently return a blob URL that would poison Firestore
                }
            });
            return Promise.all(uploads);
        }
        window.uploadMediaFilesToCloudinary = uploadMediaFilesToCloudinary;

        // =====================================================
        // FLUTTERWAVE PAYMENT GATEWAY — keys from /api/config
        // =====================================================
        const _flw = window._appConfig && window._appConfig.flutterwave;
        const FLW_PUBLIC_KEY = (_flw && _flw.publicKey) || '';
        // FLW_SECRET_KEY and FLW_ENCRYPTION_KEY live only on the server.
        // Transaction verification is proxied through /api/flw/verify.
        function initiateFlutterwavePayment(opts) {
            const txRef = 'EMPY-' + Date.now() + '-' + Math.floor(Math.random()*10000);
            if (typeof FlutterwaveCheckout === 'undefined') {
                console.warn('Flutterwave not loaded — retrying...');
                // Dynamically load if missed on page load
                const s = document.createElement('script');
                s.src = 'https://checkout.flutterwave.com/v3.js';
                s.onload = function() { initiateFlutterwavePayment(opts); };
                s.onerror = function() { if (opts.onFailure) opts.onFailure({ status: 'error', message: 'Payment gateway unavailable' }); };
                document.body.appendChild(s);
                return;
            }
            FlutterwaveCheckout({
                public_key: FLW_PUBLIC_KEY,
                tx_ref: txRef,
                amount: opts.amount,
                currency: opts.currency || 'NGN',
                payment_options: 'card,ussd,banktransfer,mobilemoney',
                customer: {
                    email: opts.email || (window.userState && window.userState.email) || 'user@empyrean.com',
                    phone_number: opts.phone || (window.userState && window.userState.phone) || '',
                    name: opts.name || (window.userState && window.userState.fullName) || 'Empyrean User'
                },
                customizations: {
                    title: 'Empyrean Humanitarian Platform',
                    description: opts.description || 'Payment',
                    logo: window._empyreanLogoSrc || ''
                },
                meta: { verified_server_side: true },   // verification via /api/flw/verify
                callback: function(response) {
                    if (response.status === 'successful') {
                        fbDb.collection('flw_transactions').doc(txRef).set({
                            txRef, amount: opts.amount, currency: opts.currency || 'NGN',
                            purpose: opts.purpose || 'general', status: 'held',
                            createdAt: _serverTimestamp()
                        }).catch(e => console.error('FLW tx save error:', e));
                        if (opts.onSuccess) opts.onSuccess(response, txRef);
                    } else {
                        if (opts.onFailure) opts.onFailure(response);
                    }
                },
                onclose: function() { if (opts.onClose) opts.onClose(); }
            });
        }

        // Firebase user helpers
        async function saveUserToFirestore(uid, userData) {
            // Wait up to 6 s for the real Firebase SDK to be ready
            if (!window._firebaseLoaded || !fbDb || !fbDb.collection) {
                await new Promise(function(resolve) {
                    var waited = 0;
                    var t = setInterval(function() {
                        waited += 300;
                        if ((window._firebaseLoaded && fbDb && fbDb.collection) || waited >= 6000) {
                            clearInterval(t); resolve();
                        }
                    }, 300);
                });
            }
            if (!fbDb || !fbDb.collection) {
                console.error('[saveUser] Firebase unavailable — cannot save uid:', uid);
                return;
            }
            const safe = { ...userData };
            ['likedPostIds','followedUserIds','retweetedPostIds','awardedRanks','completedTasks','viewedStatusUserIds']
                .forEach(k => { if (safe[k] instanceof Set) safe[k] = [...safe[k]]; });
            delete safe.password;
            safe.updatedAt = _serverTimestamp();
            try {
                await fbDb.collection('users').doc(uid).set(safe, { merge: true });
                console.log('[Firestore] ✅ User profile saved for uid:', uid);
            } catch(err) {
                console.error('[Firestore] ❌ User save failed:', err.message);
                throw err;
            }
        }
        async function loadUserFromFirestore(uid) {
            // Wait up to 6 s for the real Firebase SDK to be ready
            if (!window._firebaseLoaded || !fbDb || !fbDb.collection) {
                await new Promise(function(resolve) {
                    var waited = 0;
                    var t = setInterval(function() {
                        waited += 300;
                        if ((window._firebaseLoaded && fbDb && fbDb.collection) || waited >= 6000) {
                            clearInterval(t); resolve();
                        }
                    }, 300);
                });
            }
            if (!fbDb || !fbDb.collection) {
                console.error('[loadUser] Firebase unavailable — cannot load uid:', uid);
                return null;
            }
            const doc = await fbDb.collection('users').doc(uid).get();
            if (!doc.exists) return null;
            const data = doc.data();
            ['likedPostIds','followedUserIds','retweetedPostIds','awardedRanks','completedTasks','viewedStatusUserIds']
                .forEach(k => { data[k] = new Set(data[k] || []); });
            return data;
        }