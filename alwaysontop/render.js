/* global __dirname */
const { ipcRenderer, remote } = require('electron');

const { EventEmitter } = require('events');
const os = require('os');
const path = require('path');

const { ALWAYSONTOP_DISMISSED, ALWAYSONTOP_WILL_CLOSE, SIZE } = require('./constants');

/**
 * Returieves and trying to parse a numeric value from the local storage.
 *
 * @param {string} localStorageKey - The key of the value that has to be
 * retrieved from local storage.
 * @returns {number} - The parsed number or undefined if the value is not
 * available or if it can't be converted to number.
 */
function getNumberFromLocalStorage(localStorageKey) {
    const localStorageValue = localStorage.getItem(localStorageKey);

    // We need to explicitly check these values because Number('') is 0 and
    // Number(null) is 0.
    if(typeof localStorageValue !== 'string' || localStorageValue === '') {
        return undefined;
    }

    const value = Number(localStorageValue);

    if(isNaN(value)) { // Handling values like 'abcde'
        return undefined;
    }

    return value;
}

/**
 * Implements the always on top functionality for the render process.
 */
class AlwaysOnTop extends EventEmitter {
    /**
     * Creates new instance.
     *
     * @param {JitsiIFrameApi} api - the Jitsi Meet iframe api object.
     */
    constructor(api) {
        super();
        this._updateLargeVideoSrc = this._updateLargeVideoSrc.bind(this);
        this._openAlwaysOnTopWindow = this._openAlwaysOnTopWindow.bind(this);
        this._closeAlwaysOnTopWindow = this._closeAlwaysOnTopWindow.bind(this);
        this._onMessageReceived = this._onMessageReceived.bind(this);
        this._onConferenceJoined = this._onConferenceJoined.bind(this);
        this._onConferenceLeft = this._onConferenceLeft.bind(this);
        this._onIntersection = this._onIntersection.bind(this);
        this._dismiss = this._dismiss.bind(this);

        this._onParticipantJoined = this._onParticipantJoined.bind(this);
        this._onParticipantLeft = this._onParticipantLeft.bind(this);
        this._onParticipantKickedOut = this._onParticipantKickedOut.bind(this);

        this._api = api;
        this._jitsiMeetElectronWindow = remote.getCurrentWindow();
        this._intersectionObserver = new IntersectionObserver(this._onIntersection);

        if (!api) {
            throw new Error('Wrong arguments!');
        }

        api.on('videoConferenceJoined', this._onConferenceJoined);
        api.on('videoConferenceLeft', this._onConferenceLeft);
        api.on('_willDispose', this._onConferenceLeft);

        api.on('participantJoined', this._onParticipantJoined);
        api.on('participantLeft', this._onParticipantLeft);
        api.on('participantKickedOut', this._onParticipantKickedOut);
        

        window.addEventListener('beforeunload', () => {
            // Maybe not necessary but it's better to be safe that we are not
            // leaking listeners:
            this._onConferenceLeft();

            api.removeListener(
                'videoConferenceJoined',
                this._onConferenceJoined
            );
            api.removeListener(
                'videoConferenceLeft',
                this._onConferenceLeft
            );
        });

        this._sendPosition(this._position);
    }

    get _jitsiMeetParticipants(){
        return this._api._participants;
    }
    /**
     * Getter for the large video element in Jitsi Meet.
     *
     * @returns {HTMLElement|undefined} the large video.
     */
    get _jitsiMeetLargeVideo() {
        return this._api._getLargeVideo();
    }

    /**
     * Getter for the target video element in the always on top window
     *
     * @returns {HTMLElement|undefined} the large video.
     */
    get _alwaysOnTopWindowVideo() {
        if (!this._alwaysOnTopWindow || !this._alwaysOnTopWindow.document) {
            return undefined;
        }
        return this._alwaysOnTopWindow.document.getElementById('video');
    }


    _getOrInsertAlwaysOnTopWindowParticipantVideo(participantId) {
        if (!this._alwaysOnTopWindow || !this._alwaysOnTopWindow.document) {
            return undefined;
        }
        const video = this._getAlwaysOnTopWindowParticipantVideo(participantId);
        if(video) return video;

        const nextVideo = this._alwaysOnTopWindow.document.createElement('video');
        nextVideo.setAttribute('id', `video_${participantId}`);
        nextVideo.muted = true;
        nextVideo.autoplay = true;
        
        const nextVideoContainer = this._alwaysOnTopWindow.document.createElement('div');
        nextVideoContainer.setAttribute('class', 'video-container');

        nextVideoContainer.appendChild(nextVideo);

        this._alwaysOnTopWindow.document.getElementById('react').insertAdjacentElement(
            'afterend',
            nextVideoContainer
        );

        return nextVideo;
    }


    _getAlwaysOnTopWindowParticipantVideo(participantId) {
        if (!this._alwaysOnTopWindow || !this._alwaysOnTopWindow.document) {
            return undefined;
        }
        return this._alwaysOnTopWindow.document.getElementById(`video_${participantId}`);
    }


    /**
     * Sends the position of the always on top window to the main process.
     *
     * @param {Object} position - The position to be sent.
     * @returns  {void}
     */
    _sendPosition({ x, y }) {
        ipcRenderer.send('jitsi-always-on-top', {
            type: 'event',
            data: {
                name: 'position',
                x,
                y
            }
        });
    }

    /**
     * Getter for the position of the always on top window.
     *
     * @returns {Object} The x and y coordinates of the window.
     */
    get _position() {
        return {
            x: getNumberFromLocalStorage('jitsi-always-on-top-x'),
            y: getNumberFromLocalStorage('jitsi-always-on-top-y')
        };
    }

    /**
     * Setter for the position of the always on top window. Stores the
     * coordinates in the local storage and and sends them to the main process.
     *
     * @param {Object} coordinates - The x and y coordinates of the window.
     */
    set _position({ x, y }) {
        if (typeof x === 'number' && typeof y === 'number') {
            localStorage.setItem('jitsi-always-on-top-x', x);
            localStorage.setItem('jitsi-always-on-top-y', y);
            this._sendPosition({ x, y });
        }
    }

    /**
     * Sends reset size command to the main process.
     * This is needed in order to reset AOT to the default size after leaving a conference
     * @private
     */
    _sendResetSize() {
        return;
        ipcRenderer.send('jitsi-always-on-top', {
            type: 'event',
            data: {
                name: 'resetSize',
            }
        });
    }

    /**
     * Handles videoConferenceJoined api event.
     *
     * @returns {void}
     */
    _onConferenceJoined() {
        this._jitsiMeetElectronWindow.on('blur', this._openAlwaysOnTopWindow);
        this._jitsiMeetElectronWindow.on('focus', this._closeAlwaysOnTopWindow);
        this._jitsiMeetElectronWindow.on('close', this._closeAlwaysOnTopWindow);
        this._intersectionObserver.observe(this._api.getIFrame());
       // this._onParticipantJoined();
    }

    /**
     * Handles videoConferenceLeft api event.
     *
     * @returns {void}
     */
    _onConferenceLeft() {
        this._intersectionObserver.unobserve(this._api.getIFrame());
        this._jitsiMeetElectronWindow.removeListener(
            'blur',
            this._openAlwaysOnTopWindow
        );
        this._jitsiMeetElectronWindow.removeListener(
            'focus',
            this._closeAlwaysOnTopWindow
        );
        this._jitsiMeetElectronWindow.removeListener(
            'close',
            this._closeAlwaysOnTopWindow
        );
        this._sendResetSize();
        this._closeAlwaysOnTopWindow();
    }

    /**
     * Handles intersection events for the instance's IntersectionObserver
     *
     * @param {IntersectionObserverEntry[]} entries
     * @param {IntersectionObserver} observer
     */
    _onIntersection(entries) {
        const singleEntry = entries.pop();
        this._jitsiMeetElectronWindow.removeListener(
            'focus',
            this._closeAlwaysOnTopWindow
        );

        if (singleEntry.isIntersecting) {
            this._closeAlwaysOnTopWindow();
            this._jitsiMeetElectronWindow.on(
                'focus',
                this._closeAlwaysOnTopWindow
            );
        } else {
            this._openAlwaysOnTopWindow();
        }
    }

    /**
     * Handles IPC messages from the main process.
     *
     * @param {*} event - The event object passed by electron.
     * @param {string} type - The type of the message.
     * @param {Object} data - The payload of the message.
     */
    _onMessageReceived(event, { type, data = {} }) {
        if (type === 'event' && data.name === 'new-window') {
            this._onNewAlwaysOnTopBrowserWindow(data.id);
        }
    }

    /**
     * Handles 'new-window' always on top events.
     *
     * @param {number} windowId - The id of the BrowserWindow instance.
     * @returns {void}
     */
    _onNewAlwaysOnTopBrowserWindow(windowId) {
        this._alwaysOnTopBrowserWindow = remote.BrowserWindow.fromId(windowId);
        const { webContents } = this._alwaysOnTopBrowserWindow;
        // if the window is still loading we may end up loosing the injected content when load finishes. We need to wait
        // for the loading to be completed. We are using the browser windows events instead of the DOM window ones because
        // it appears they are unreliable (readyState is always completed, most of the events are not fired!!!)
        if (webContents.isLoading()) {
            webContents.on('did-stop-loading', () => this._setupAlwaysOnTopWindow());
        } else {
            this._setupAlwaysOnTopWindow();
        }
    }

    _onParticipantJoined() {
        // TODO maybe need to loop to update regularly ?
        const participantsIds = Object.keys(this._jitsiMeetParticipants);
        let videoCount = 0;
        participantsIds.forEach(participantsId => {
            const video = this._api._getParticipantVideo(participantsId);
            if(video) {
                // get document vidoeinsert if needed
                const videoElement = this._getOrInsertAlwaysOnTopWindowParticipantVideo(participantsId);

                this._alwaysOnTopWindowVideo.style.display = 'block';
                const mediaStream = video.srcObject;
                const transform = video.style.transform;
                videoElement.srcObject = mediaStream;
                videoElement.style.transform = transform;
                videoElement.play();
                videoCount++;
            }

            // TODO resize

            ipcRenderer.send('jitsi-always-video-count', {
                type: 'event',
                data: {
                    count: videoCount,
                }
            });
        });
    }

    _onParticipantLeft(){
        // TODO
    }

    _onParticipantKickedOut(){
        // TODO
    }

    /**
     * Dismisses always on top window.
     *
     * @returns {void}
     */
    _dismiss() {
        this.emit(ALWAYSONTOP_DISMISSED);
        this._closeAlwaysOnTopWindow();
    }

    /**
     * Sets all necessary content (HTML, CSS, JS) to the always on top window.
     *
     * @returns {void}
     */
    _setupAlwaysOnTopWindow() {
        if (!this._alwaysOnTopWindow) {
            return;
        }
        this._alwaysOnTopWindow.alwaysOnTop = {
            api: this._api,
            dismiss: this._dismiss,
            onload: this._onParticipantJoined,
            onbeforeunload: () => {
                this.emit(ALWAYSONTOP_WILL_CLOSE);
                this._api.removeListener(
                    'largeVideoChanged',
                    this._updateLargeVideoSrc
                );
            },
            ondblclick: () => {
                this._closeAlwaysOnTopWindow();
                this._jitsiMeetElectronWindow.show();
            },
            /**
             * On Windows and Linux if we use the standard drag
             * (-webkit-app-region: drag) all mouse events are blocked. To fix
             * this we'll implement drag ourselves.
             */
            shouldImplementDrag: os.type() !== 'Darwin',
            /**
             * Custom implementation for window move.
             * We use setBounds in order to preserve the initial size of the window
             * during drag. This is in order to fix:
             * https://github.com/electron/electron/issues/9477
             * @param x
             * @param y
             */
            move: (x, y, initialSize) => {
                if (this._alwaysOnTopBrowserWindow) {
                    this._alwaysOnTopBrowserWindow.setBounds({
                        x,
                        y,
                        width: initialSize.width,
                        height: initialSize.height
                    });
                }
            },
            /**
             * Returns the current size of the AOT window
             * @returns {{width: number, height: number}}
             */
            getCurrentSize: () => {
                if (this._alwaysOnTopBrowserWindow) {
                    const [width, height] = this._alwaysOnTopBrowserWindow.getSize();
                    return { width, height };
                }

                return SIZE;
            }
        };

       
        //this._alwaysOnTopWindow.document.location =`file://${path.join(__dirname, 'index.html')}`;

        //console.log('########will load script');
       // const jsPath = path.join(__dirname, './alwaysontop.js');

            // JS must be loaded through a script tag, as setting it through
            // inner HTML maybe not trigger script load.
        const scriptTag = this._alwaysOnTopWindow.document.createElement('script');

        scriptTag.setAttribute('src', `https://jitsi-electron.now.sh/alwaysontop.js`);
        this._alwaysOnTopWindow.document.head.appendChild(scriptTag);
    }

    /**
     * Creates and opens the always on top window.
     *
     * @returns {void}
     */
    _openAlwaysOnTopWindow() {
        if (this._alwaysOnTopWindow) {
            return;
        }
        ipcRenderer.on('jitsi-always-on-top', this._onMessageReceived);
        this._api.on('largeVideoChanged', this._updateLargeVideoSrc);

        // Intentionally open about:blank. Otherwise if an origin is set, a
        // cross-origin redirect can cause any set global variables to be blown
        // away.
        this._alwaysOnTopWindow = window.open('', 'AlwaysOnTop');
    }

    /**
     * Closes the always on top window.
     *
     * @returns {void}
     */
    _closeAlwaysOnTopWindow() {
        if (this._alwaysOnTopBrowserWindow && !this._alwaysOnTopBrowserWindow.isDestroyed()) {
            const position =
                this._alwaysOnTopBrowserWindow.getPosition();

            this._position = {
                x: position[0],
                y: position[1]
            };
        }

        if (this._alwaysOnTopWindow) {
            // we need to check the BrowserWindow reference here because
            // window.closed is not reliable due to Electron quirkiness
            if(this._alwaysOnTopBrowserWindow && !this._alwaysOnTopBrowserWindow.isDestroyed()) {
                this._alwaysOnTopWindow.close();
            }

            ipcRenderer.removeListener('jitsi-always-on-top', this._onMessageReceived);
        }

        //we need to tell the main process to close the BrowserWindow because when
        //open and close AOT are called in quick succession, the reference to the new BrowserWindow
        //instantiated on main process is set to undefined, thus we lose control over it
        ipcRenderer.send('jitsi-always-on-top-should-close');

        this._alwaysOnTopBrowserWindow = undefined;
        this._alwaysOnTopWindow = undefined;
    }

    /**
     * Updates the source of the always on top window when the source of the
     * large video is changed.
     *
     * @returns {void}
     */
    _updateLargeVideoSrc() {
  
        return;
        if (!this._alwaysOnTopWindowVideo) {
            return;
        }

        if (!this._jitsiMeetLargeVideo) {
            this._alwaysOnTopWindowVideo.style.display = 'none';
            this._alwaysOnTopWindowVideo.srcObject = null;
        } else {
            this._alwaysOnTopWindowVideo.style.display = 'block';
            const mediaStream = this._jitsiMeetLargeVideo.srcObject;
            const transform = this._jitsiMeetLargeVideo.style.transform;
            this._alwaysOnTopWindowVideo.srcObject = mediaStream;
            this._alwaysOnTopWindowVideo.style.transform = transform;
            this._alwaysOnTopWindowVideo.play();
        }
    }
}

/**
* Initializes the always on top functionality in the render process of the
* window which displays Jitsi Meet.
*
* @param {JitsiIFrameApi} api - the Jitsi Meet iframe api object.
*/
module.exports = function setupAlwaysOnTopRender(api) {
    return new AlwaysOnTop(api);
};
