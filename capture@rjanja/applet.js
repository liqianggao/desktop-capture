/**
 * Cinnamon Desktop Capture applet.
 *
 * @author  Robert Adams <radams@artlogic.com>
 * @link    http://github.com/rjanja/desktop-capture/
 */


const Cinnamon = imports.gi.Cinnamon;
const Applet = imports.ui.applet;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Meta = imports.gi.Meta;
const PopupMenu = imports.ui.popupMenu;
const PopupSliderMenuItem = imports.ui.popupMenu.PopupSliderMenuItem;
const PopupSwitchMenuItem = imports.ui.popupMenu.PopupSwitchMenuItem;
const PopupBaseMenuItem = imports.ui.popupMenu.PopupBaseMenuItem;
const Switch = imports.ui.popupMenu.Switch;
const Clutter = imports.gi.Clutter;
const Lightbox = imports.ui.lightbox;
const Settings = imports.ui.settings;
const MessageTray = imports.ui.messageTray;
const Signals = imports.signals;

const Util = imports.misc.util;
const GLib = imports.gi.GLib;
const Gio = imports.gi.Gio;
const Lang = imports.lang;
const St = imports.gi.St;
const Gtk = imports.gi.Gtk;

const CAMERA_PROGRAM_GNOME = 'gnome-screenshot';
const KEY_GNOME_SCREENSHOT_SCHEMA = "org.gnome.gnome-screenshot"
const KEY_GNOME_INCLUDE_CURSOR = "include-pointer";
const KEY_GNOME_DELAY_SECONDS = "delay";

const KEY_RECORDER_SCHEMA = "org.cinnamon.recorder";
const KEY_RECORDER_FRAMERATE = "framerate";
const KEY_RECORDER_FILE_EXTENSION = "file-extension";
const KEY_RECORDER_PIPELINE = "pipeline";

// Uploading
const Soup = imports.gi.Soup
const IMGUR_CRED = "85a61980ca1cc59f329ee172245ace84";
let session = new Soup.SessionAsync();
Soup.Session.prototype.add_feature.call(session, new Soup.ProxyResolverDefault());

const ClipboardCopyType = {
   OFF: 0,
   DEFAULT: 1,
   PATH: 1,
   DIRECTORY: 2,
   FILENAME: 3,
   IMAGEDATA: 4
}

// Globals we'll set once we have metadata in main()
let Capture;
let Screenshot;
let AppletDir;
let SUPPORT_FILE;
let SETTINGS_FILE;
let ICON_FILE;
let ICON_FILE_ACTIVE;
let CLIPBOARD_HELPER;

// We use an altered URLHighlighter because /tmp looks better than file://tmp/,
// and I'm a picky SOB.
function URLHighlighter(text, lineWrap, allowMarkup) {
   this._init(text, lineWrap, allowMarkup);
}
URLHighlighter.prototype = {
   __proto__: MessageTray.URLHighlighter.prototype,

   _init: function(text, lineWrap, allowMarkup) {
      MessageTray.URLHighlighter.prototype._init.call(this, text, lineWrap, allowMarkup);
   },

   // _shortenUrl doesn't exist in base class
   _shortenUrl: function(url) {
      if (url.substring(0, 7) == 'http://') {
         return url.substring(7);
      }
      else if (url.substring(0, 7) == 'file://') {
         return url.substring(7);
      }
      return url;
   },

   _highlightUrls: function() {
        // text here contain markup
        let urls = Util.findUrls(this._text);
        let markup = '';
        let pos = 0;
        for (let i = 0; i < urls.length; i++) {
            let url = urls[i];
            let str = this._text.substr(pos, url.pos - pos);
            let shortUrl = this._shortenUrl(url.url);

            markup += str + '<span foreground="' + this._linkColor + '"><u>' + shortUrl + '</u></span>';
            pos = url.pos + url.url.length;

            if (shortUrl != url.url) {
               // Save the altered match position
               this._urls[i].pos -= url.url.length - shortUrl.length;
            }
        }
        markup += this._text.substr(pos);
        this.actor.clutter_text.set_markup(markup);
    },
}

function Source(sourceId, screenshot) {
    this._init(sourceId, screenshot);
}

Source.prototype = {
   ICON_SIZE: 24,

   __proto__ : MessageTray.Source.prototype,

   _init: function(sourceId, screenshot) {
      MessageTray.Source.prototype._init.call(this, sourceId);

      // @todo summary items
      /*let icon_file = Gio.file_new_for_path(ICON_FILE);
      let icon_uri = icon_file.get_uri();
      let icon_texture = St.TextureCache.get_default().load_uri_async(icon_uri, this.ICON_SIZE, this.ICON_SIZE);
      this._setSummaryIcon(this.createNotificationIcon());*/
   },

   createNotificationIcon: function() {
      let icon_file = Gio.file_new_for_path(ICON_FILE_ACTIVE);
      let icon_uri = icon_file.get_uri();
      return St.TextureCache.get_default().load_uri_async(icon_uri, this.ICON_SIZE, this.ICON_SIZE);
   }
}

function ScreenshotNotification(source, title, banner, params) {
   this._init(source, title, banner, params);
}
ScreenshotNotification.prototype = {
   __proto__: MessageTray.Notification.prototype,
   _delayedResident: null,
   _cursorChanged: false,

   _init: function(source, title, banner, params) {
      MessageTray.Notification.prototype._init.call(this, source, title, banner, params);
   },

   // We override setImage so we can change row_span from 2->1.
   setImage: function(image) {
      if (this._imageBin)
         this.unsetImage();

      // Make our bin reactive so we can click on it
      this._imageBin = new St.Bin({ reactive: true, style_class: 'screenshot-thumbnail' });
      this._imageBin.child = image;
      this._imageBin.opacity = 230;

      

      this._table.add_style_class_name('multi-line-notification');
      // Only show expanded image style if we also have actions to display
      this._actionArea && this._table.add_style_class_name('notification-with-image');
      this._addBannerBody();
      this._updateLastColumnSettings();
      this._table.add(this._imageBin, { row: 1,
                                       col: 1,
                                       row_span: 2,
                                       x_expand: true,
                                       y_expand: true,
                                       x_fill: true,
                                       y_fill: true });

      // Make the image thumbnail interactive
      this._imageBin.connect('button-press-event', Lang.bind(this, this._onImageButtonPressed));
      this._imageBin.connect('motion-event', Lang.bind(this, function(actor, event) {
         if (!actor.visible || actor.get_paint_opacity() == 0)
             return false;

         global.set_cursor(Cinnamon.Cursor.POINTING_HAND);
         this._cursorChanged = true;
         this._imageBin.add_style_class_name('screenshot-thumbnail-hover');
         return false;
      }));
      this._imageBin.connect('leave-event', Lang.bind(this, function() {
         if (!this._imageBin.visible || this._imageBin.get_paint_opacity() == 0)
            return;

         if (this._cursorChanged) {
            this._cursorChanged = false;
            global.unset_cursor();
            this._imageBin.remove_style_class_name('screenshot-thumbnail-hover');
         }
      }));
   },

   _onImageMouseover: function(actor, event) {
      //global.log('mouseover!!');
   },

   // Expose the clicks now and maybe we'll allow configurable behavior later
   _onImageButtonPressed: function(actor, event) {
      if (event.get_button() == 1) {
         this.emit('image-left-clicked');
         return true;
      }
      else if (event.get_button() == 3) {
         this.emit('image-right-clicked');
      }
      else if (event.get_button() == 2) {
         this.emit('image-middle-clicked');
      }

      return false;
   },

   // Similarly we need to change the action area to spn both columns.
   _updateLastColumnSettings: function() {
        if (this._scrollArea)
            this._table.child_set(this._scrollArea, { col: 2,
                                                      col_span: 1 });
        if (this._actionArea)
            this._table.child_set(this._actionArea, { row: 3, col: 1,
                                                      row_span: 1,
                                                      col_span: 2,
                                                      x_fill: false,
                                                      x_expand: false });
   },

   // Set resident->nonresident when action is clicked
   setDelayedResident: function(isResident) {
      this._delayedResident = isResident;
   },

   _onActionInvoked: function(actor, mouseButtonClicked, id) {
      this.emit('action-invoked', id);
      if (!this.resident) {
         this.emit('done-displaying');
         this.destroy();
      }

      if (this._delayedResident != null) {
         true == this._delayedResident && this.emit('done-displaying');
         this.setDelayedResident(this._delayedResident);
         this._delayedResident = null;
      }
   },

   addBody: function(text, markup, style) {
      let label = new URLHighlighter(text, true, markup);

      this.addActor(label.actor, style);
      return label.actor;
   }
}


function StubbornSwitchMenuItem() {
    this._init.apply(this, arguments);
}

StubbornSwitchMenuItem.prototype = {
   __proto__: PopupSwitchMenuItem.prototype,

    _init: function(text, active, params) {
        //PopupSwitchMenuItem.prototype._init.call(this, text, active, params);
        PopupBaseMenuItem.prototype._init.call(this, params);

        this.label = new St.Label({ text: text, style_class: 'popup-switch-menu-label' });
        this._switch = new Switch(active);

        this.addActor(this.label);

        this._statusBin = new St.Bin({ style_class: 'popup-switch-menu-bin', x_align: St.Align.END });
        this.addActor(this._statusBin,
                      { expand: false, span: -1 });

        this._statusLabel = new St.Label({ text: '',
                                           style_class: 'popup-inactive-menu-item'
                                         });
        this._statusBin.child = this._switch.actor;
    },

   activate: function(event) {
      if (this._switch.actor.mapped) {
         this.toggle();
      }

      // we allow pressing space to toggle the switch
      // without closing the menu
      if (event.type() == Clutter.EventType.KEY_PRESS &&
         event.get_key_symbol() == Clutter.KEY_space)
         return;

      //PopupBaseMenuItem.prototype.activate.call(this, event);
   },
};

function StubbornComboMenuItem() {
    this._init.apply(this, arguments);
}

StubbornComboMenuItem.prototype = {
   __proto__: PopupBaseMenuItem.prototype,

    _init: function(text, active, onChange) {
         PopupBaseMenuItem.prototype._init.call(this, { reactive: false,
                      style_class: 'delay-chooser' });

         /*this._iconBin = new St.Button({ style_class: 'delay-chooser-user-icon' });
         this.addActor(this._iconBin);

         this._iconBin.connect('clicked', Lang.bind(this,
            function() {
                this.activate();
            }));*/

         this.label = new St.Label({ text: text, style_class: 'delay-chooser-label' });
         this.addActor(this.label);

         this._section = new PopupMenu.PopupMenuSection();
         this.addActor(this._section.actor);

         this._combo = new PopupMenu.PopupComboBoxMenuItem({ style_class: 'popup-combo' });
         this._section.addMenuItem(this._combo);

         let item;

         item = new PopupMenu.PopupMenuItem(_("None"));
         this._combo.addMenuItem(item);

         item = new PopupMenu.PopupMenuItem(_("1 sec"));
         this._combo.addMenuItem(item);

         item = new PopupMenu.PopupMenuItem(_("2 sec"));
         this._combo.addMenuItem(item);

         item = new PopupMenu.PopupMenuItem(_("3 sec"));
         this._combo.addMenuItem(item);

         item = new PopupMenu.PopupMenuItem(_("5 sec"));
         this._combo.addMenuItem(item);

         this._combo.connect('active-item-changed', onChange);

         this._combo.setSensitive(true);
         this._combo.setActiveItem(active);

         return true;
   }
};

function MyAppletPopupMenu(launcher, orientation, animateClose) {
    this._init(launcher, orientation, animateClose);
}

MyAppletPopupMenu.prototype = {
   __proto__: Applet.AppletPopupMenu.prototype,

   _init: function(launcher, orientation, animateClose) {
      Applet.AppletPopupMenu.prototype._init.call(this, launcher, orientation);
      this._animateClose = animateClose;
   },

   addAction: function(title, callback) {
      let menuItem = new MyPopupMenuItem(title, { });
      this.addMenuItem(menuItem);
      menuItem.connect('activate', Lang.bind(this, function (menuItem, event) {
         callback(event);
         return false;
      }));

      return menuItem;
   },

   close: function(animate) {
      if (!this.isOpen)
         return;
         
      global.menuStackLength -= 1;

      Main.panel._hidePanel();
      if (Main.panel2 != null)
         Main.panel2._hidePanel();

      if (this._activeMenuItem)
         this._activeMenuItem.setActive(false);

      this._boxPointer.hide(this._animateClose);

      this.isOpen = false;
      this.emit('open-state-changed', false);
   }
}

function MyPopupMenuItem()
{
   this._init.apply(this, arguments);
}

MyPopupMenuItem.prototype =
{
   __proto__: PopupMenu.PopupMenuItem.prototype,

   _init: function (text, params) {
      PopupMenu.PopupMenuItem.prototype._init.call(this, text, params);
   }
};

function TextImageMenuItem() {
    this._init.apply(this, arguments);
}

TextImageMenuItem.prototype = {
    __proto__: PopupMenu.PopupBaseMenuItem.prototype,

    _init: function(text, icon, image, align, style) {
        PopupMenu.PopupBaseMenuItem.prototype._init.call(this);

        this.actor = new St.BoxLayout({style_class: style});
        this.actor.add_style_pseudo_class('active');
        if (icon) {
            this.icon = new St.Icon({icon_name: icon});
        }
        if (image) {
            this.icon = new St.Bin();
            this.icon.set_child(this._getIconImage(image));
        }
        this.text = new St.Label({text: text});
        if (align === "left") {
            this.actor.add_actor(this.icon, { span: 0 });
            this.actor.add_actor(this.text, { span: -1 });
        }
        else {
            this.actor.add_actor(this.text, { span: 0 });
            this.actor.add_actor(this.icon, { span: -1 });
        }
    },

    setText: function(text) {
        this.text.text = text;
    },

    setIcon: function(icon) {
        this.icon.icon_name = icon;
    },

    setImage: function(image) {
        this.icon.set_child(this._getIconImage(image));
    },

    // retrieve an icon image
    _getIconImage: function(icon_name) {
         let icon_file = icon_path + icon_name + ".svg";
         let file = Gio.file_new_for_path(icon_file);
         let icon_uri = file.get_uri();

         return St.TextureCache.get_default().load_uri_async(icon_uri, 16, 16);
    },
}

function getSettings(schema) {
   try {
      if (Gio.Settings.list_schemas().indexOf(schema) == -1)
         throw _("Schema \"%s\" not found.").format(schema);
      return new Gio.Settings({ schema: schema });
   }
   catch (e) {
      return null;
   }
}

function LocalSettings(uuid, instanceId) {
   this._init(uuid, instanceId);
}
LocalSettings.prototype = {
   _init: function(uuid, instanceId) {
      this._initialized = false;
      this._localSettings = false;
      this._filename = SETTINGS_FILE = AppletDir + '/settings.json';;
      this._settingsFile = Gio.file_new_for_path(this._filename);
      this._settings = this._oldSettings = {};
      this._monitor = this._settingsFile.monitor(Gio.FileMonitorFlags.NONE, null);
      this._monitor.connect('changed', Lang.bind(this, this._settingsChanged));
      this._settingsChanged();
      this._initialized = true;
   },

   _settingsChanged: function(monitor, fileObj, n, eventType) {
      //global.log('LocalSettings settingsChanged');
      if (eventType !== undefined && eventType != Gio.FileMonitorEvent.CHANGES_DONE_HINT) {
         return true;
      }

      try {
         this._settings = JSON.parse(Cinnamon.get_file_contents_utf8_sync(this._filename));
         this.emit("settings-changed");
         if (this._initialized) {
            for (var k in this._settings) {
               if (this._settings[k] !== this._oldSettings[k])
               {
                  //global.log('emitting changed::'+k);
                  this.emit("changed::"+k, k, this._oldSettings[k], this._settings[k]);
               }
            }
         }
         this._oldSettings = this._settings;
      }
      catch (e) {
         global.logError("Could not parse " + this._filename);
         global.logError(e);
      }
      return true;
   },

   getValue: function(settings_key) {
      return this._settings[settings_key];
   },

   setValue: function(settings_key, value) {
      this._settings[settings_key] = value;
      this.writeSettings();
   },

   writeSettings: function() {
      let filedata = JSON.stringify(this._settings, null, "   ");
      GLib.file_set_contents(this._filename, filedata, filedata.length);
   }
};
Signals.addSignalMethods(LocalSettings.prototype);

function MyApplet(metadata, orientation, panelHeight, instanceId) {
   this._init(metadata, orientation, panelHeight, instanceId);
}

MyApplet.prototype = {
   __proto__: Applet.IconApplet.prototype,

   _notificationImageSize: 128,
   _notificationIconSize: 24,

   log: function(msg) {
      //return;
      if (typeof msg == 'object') {
         global.log(msg);
      }
      else {
         global.log(this._uuid + ': ' + msg);
      }
      
   },

   _initSettings: function() {
      try {
         //xyz();
         this.settings = new Settings.AppletSettings(this, this._uuid, this._instanceId);
         this.log('Using AppletSettings');
         this._localSettings = false;
      }
      catch (e) {
         this.log('Falling back to LocalSettings');
         this.settings = new LocalSettings(this._uuid, this._instanceId);
         this._localSettings = true;
      }
      
      this.settings.connect("settings-changed", Lang.bind(this, this._onSettingsChanged));
      this.settings.connect("changed::camera-program", Lang.bind(this, this._onRuntimeChanged));
      this.settings.connect("changed::recorder-program", Lang.bind(this, this._onRuntimeChanged));
      this.settings.connect("changed::use-symbolic-icon", Lang.bind(this, this._onRuntimeChanged));
      this.settings.connect("changed::show-copy-toggle", Lang.bind(this, this._onRuntimeChanged));
      this.settings.connect("changed::show-upload-toggle", Lang.bind(this, this._onRuntimeChanged));

      this._onSettingsChanged();
   },

   /*_onKeybindingChanged: function(key, oldVal, newVal, type, index) {
      Main.keybindingManager.addHotKey(key, newVal, Lang.bind(this, function(e) {
         return this.run_cinnamon_camera(type, e, index);
      }));
   },*/

   stop_any_recorder: function() {
      if (this.get_recorder_program() == 'cinnamon') {
         this._toggle_cinnamon_recorder();
      }
      else if (this.has_recorder_option('stop-command')) {
         this.runCommand(this.get_recorder_option('stop-command'), 'recorder', false);
      }
   },

   _onKeybindingChanged: function(provider, key, oldVal, newVal) {
      //global.log('binding change for '+key+' to '+(newVal ? newVal : '[]'));
      Main.keybindingManager.addHotKey(key, newVal, Lang.bind(this, function(e) {
         //global.log('called bindFn with key '+key);
         //global.log(typeof this._bindFns[key]);
         return this._bindFns[key]();
      }));
   },

   registerKeyBinding: function(key, captureType, index) {
      //global.log('registering key binding for '+key);
      this._bindFns[key] = Lang.bind(this, function() {
         //global.log('bindFn running for type ' + captureType);
         if (captureType == 'RECORDER') {
            return this.stop_any_recorder();
         }
         else {
            return this.run_cinnamon_camera(captureType, null, index);
         }
      });
      
      // Read current value and if set, add the hotkey
      var curVal = this.settings.getValue(key);
      if (curVal != '' && curVal != null)
      {
         this._onKeybindingChanged(null, key, null, curVal);
      }

      // Rebind with any future changes
      this.settings.connect("changed::"+key, Lang.bind(this, this._onKeybindingChanged));
   },

   _registerKeyBindings: function() {
      if (this._localSettings) return;

      if (this.has_camera()) {
         if (this.get_camera_program() == 'cinnamon') {
            this.registerKeyBinding('kb-cs-window', Screenshot.SelectionType.WINDOW);
            this.registerKeyBinding('kb-cs-area', Screenshot.SelectionType.AREA);
            this.registerKeyBinding('kb-cs-ui', Screenshot.SelectionType.CINNAMON);
            this.registerKeyBinding('kb-cs-screen', Screenshot.SelectionType.SCREEN);
            //this.registerKeyBinding('cs-monitor', Screenshot.SelectionType.MONITOR);

            if (Main.layoutManager.monitors.length > 1) {
               Main.layoutManager.monitors.forEach(Lang.bind(this, function(monitor, index) {
                  this.registerKeyBinding('kb-cs-monitor-' + index, Screenshot.SelectionType.MONITOR, index);
               }));
            }

            this.registerKeyBinding('kb-recorder-stop', 'RECORDER');

            /*this.settings.connect("changed::kb-cs-window", Lang.bind(this. this._onKeybindingChanged,
              Screenshot.SelectionType.WINDOW));
            this.settings.connect("changed::kb-cs-area", Lang.bind(this. this._onKeybindingChanged,
              Screenshot.SelectionType.AREA));
            this.settings.connect("changed::kb-cs-ui", Lang.bind(this. this._onKeybindingChanged,
              Screenshot.SelectionType.CINNAMON));
            this.settings.connect("changed::kb-cs-screen", Lang.bind(this. this._onKeybindingChanged,
              Screenshot.SelectionType.SCREEN));
            this.settings.connect("changed::kb-cs-window", Lang.bind(this. this._onKeybindingChanged,
              Screenshot.SelectionType.MONITOR));

            if (Main.layoutManager.monitors.length > 1) {
               Main.layoutManager.monitors.forEach(function(monitor, index) {
                  this.settings.connect("changed::kb-cs-monitor-" + index, Lang.bind(this. this._onKeybindingChanged,
                     Screenshot.SelectionType.MONITOR, index));
            }*/
         }
      }
   },

   _onSettingsChanged: function(evt, type) {
      //this.log('_onSettingsChanged('+type+')');
      this._includeCursor = this.settings.getValue('include-cursor');
      this._openAfter = this.settings.getValue('open-after');
      this._delay = this.settings.getValue('delay-seconds');
      this._cameraProgram = this.settings.getValue('camera-program');
      this._recorderProgram = this.settings.getValue('recorder-program');

      this._cameraSaveDir = this.settings.getValue('camera-save-dir');
      if (this._cameraSaveDir == "" || this._cameraSaveDir === null) {
         this._cameraSaveDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES);
      }

      this._recorderSaveDir = this.settings.getValue('recorder-save-dir');
      if (this._recorderSaveDir == "" || this._recorderSaveDir === null) {
         this._recorderSaveDir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS);
      }

      // Allow save locations to begin with a tilde.
      let input;

      if (this._cameraSaveDir.charAt(0) == '~') {
         input = this._cameraSaveDir.slice(1);
         this._cameraSaveDir = GLib.get_home_dir() + '/' + input;
         this.settings.setValue('camera-save-dir', this._cameraSaveDir);
      }

      if (this._recorderSaveDir.charAt(0) == '~') {
         input = this._recorderSaveDir.slice(1);
         this._recorderSaveDir = GLib.get_home_dir() + '/' + input;
         this.settings.setValue('recorder-save-dir', this._recorderSaveDir);
      }

      this._cameraSavePrefix = this.settings.getValue('camera-save-prefix');
      this._recorderSavePrefix = this.settings.getValue('recorder-save-prefix');
      this._windowAsArea = this.settings.getValue('capture-window-as-area');
      this._includeWindowFrame = this.settings.getValue('include-window-frame');
      this._useCameraFlash = this.settings.getValue('use-camera-flash');
      this._useTimer = this.settings.getValue('use-timer');
      this._playShutterSound = this.settings.getValue('play-shutter-sound');
      this._playIntervalSound = this.settings.getValue('play-timer-interval-sound');
      this._copyToClipboard = this.settings.getValue('copy-to-clipboard');
      this._copyData = this.settings.getValue('copy-data');
      this._showCopyToggle = this.settings.getValue('show-copy-toggle');
      this._copyDataAutoOff = this.settings.getValue('copy-data-auto-off');
      this._sendNotification = this.settings.getValue('send-notification');
      this._includeStyles = this.settings.getValue('include-styles');
      this._showUploadToggle = this.settings.getValue('show-upload-toggle');
      this._uploadAutoOff = this.settings.getValue('upload-auto-off');
      this._uploadToImgur = this.settings.getValue('upload-to-imgur');
      this._useSymbolicIcon = this.settings.getValue('use-symbolic-icon');
      this._recordSound = this.settings.getValue('record-sound');
      this._notificationBehavior = this.settings.getValue('notification-behavior');
      this._showDeleteAction = this.settings.getValue('show-delete-action');
      this._showUploadAction = this.settings.getValue('show-upload-action');
      this._showCopyPathAction = this.settings.getValue('show-copy-path-action');
      this._showCopyDataAction = this.settings.getValue('show-copy-data-action');

      if (this._cameraProgram == 'none')
      {
         this._cameraProgram = null;
      }

      if (this._recorderProgram == 'none')
      {
         this._recorderProgram = null;
      }

      if (this._shouldRedraw) {
         this.draw_menu();
         this._shouldRedraw = false;
      }

      this._checkPaths();

      return false;
   },

   getSettingValue: function(key) {
      return this.settings.getValue(key);
   },

   setSettingValue: function(key, value) {
      return this.settings.setValue(key, value);
   },

   getModifier: function(symbol) {
      //global.log('getModifier ' + symbol);
      return this._modifiers[symbol] || false;
   },

   setModifier: function(symbol, value) {
      //global.log('setModifier ' + symbol);
      this._modifiers[symbol] = value;
   },

   _onMenuKeyRelease: function(actor, event) {
      let symbol = event.get_key_symbol();

      if (symbol == Clutter.Shift_L)
      {
         this.setModifier(symbol, false);
      }

      return false;
   },

   _onMenuKeyPress: function(actor, event) {
      let symbol = event.get_key_symbol();
      
      if (symbol == Clutter.Shift_L)
      {
         this.setModifier(symbol, true);
      }

      return false;
   },

   _onRuntimeChanged: function(settingsObj, key, oldVal, newVal) {
      //this.log('runtimeChanged: ' + oldVal + ', ' + newVal);
      this._shouldRedraw = true;
   },

    _crSettingsChanged: function(settings, key) {
        if (this._recorderProgram == 'cinnamon')
        {
           this.cRecorder = new Cinnamon.Recorder({ stage: global.stage });
        }
        this._crFrameRate = this._crSettings.get_int(KEY_RECORDER_FRAMERATE);
        this._crFileExtension = this._crSettings.get_string(KEY_RECORDER_FILE_EXTENSION);
        this._crPipeline = this._crSettings.get_string(KEY_RECORDER_PIPELINE);
        return false;
    },

   _init: function(metadata, orientation, panelHeight, instanceId) {
      Applet.IconApplet.prototype._init.call(this, orientation);
      
      try {
         this._programs = {};
         this._programSupport = {};
         this._bindFns = {};
         this._includeCursor = false;
         this._openAfter = false;
         this._delay = 0;
         this._useTimer = false;
         this._copyData = false;
         this._showCopyToggle = true;
         this._copyDataAutoOff = true;
         this._showUploadToggle = false;
         this._uploadToImgur = false;
         this._uploadAutoOff = true;
         this._recordSound = true;
         this.orientation = orientation;
         this.cRecorder = null;
         this._crFrameRate = null;
         this._crFileExtension = null;
         this._crPipeline = null;
         this._redoMenuItem = null;
         this._useSymbolicIcon = false;
         this.lastCapture = null;
         this._instanceId = instanceId;
         this._uuid = metadata.uuid;
         this._shouldRedraw = false;
         this._customControls = [];
         this._customCommandItems = [];
         this._customSettings = {};
         this._updateCustomTimeoutId = null;

         this.maybeRegisterRole("screenshot", metadata.uuid);

         // Create our right-click menus first, they'll be modified once
         // settings are loaded in the event one or both the save folders
         // do not exist or are not writeable
         this.openScreenshotsFolderItem = new Applet.MenuItem(_("Open screenshots folder"),
            'folder', Lang.bind(this, this._openScreenshotsFolder));
         this._applet_context_menu.addMenuItem(this.openScreenshotsFolderItem);
         
         this.openRecordingsFolderItem = new Applet.MenuItem(_("Open recordings folder"),
            'folder', Lang.bind(this, this._openRecordingsFolder));
         this._applet_context_menu.addMenuItem(this.openRecordingsFolderItem);

         // Load up our settings
         this._initSettings();

         // GNOME Screenshot settings, we only write cursor option,
         // don't need to read anything from it.
         this._ssSettings = getSettings(KEY_GNOME_SCREENSHOT_SCHEMA);

         // Cinnamon Recorder settings
         this._crSettings = getSettings(KEY_RECORDER_SCHEMA);
         this._crSettings.connect('changed', Lang.bind(this, this._crSettingsChanged));
         this._crSettingsChanged();

         // Get information on what our various programs support
         let supportFile = GLib.build_filenamev([SUPPORT_FILE]);
         try {
            this._programSupport = JSON.parse(Cinnamon.get_file_contents_utf8_sync(supportFile));
         }
         catch (e) {
            global.logError("Could not parse Desktop Capture's support.json!")
            global.logError(e);
         }

         this._registerKeyBindings();

         //this.detect_programs();
         let xfixesCursor = Cinnamon.XFixesCursor.get_for_stage(global.stage);
         this._xfixesCursor = xfixesCursor;

         this.actor.add_style_class_name('desktop-capture');
         
         this.set_applet_tooltip(_("Screenshot and desktop video"));

         this.draw_menu(orientation);

         // When monitors are connected or disconnected, redraw the menu
         Main.layoutManager.connect('monitors-changed', Lang.bind(this, this.draw_menu));

         // Add the right-click context menu item. This only needs
         // to be drawn a single time.
         if (this._localSettings) {
            this.settingsItem = new Applet.MenuItem(_("Capture settings"),
               'system-run', Lang.bind(this, this._launch_settings));

            this._applet_context_menu.addMenuItem(this.settingsItem);
         }

         this._checkPaths(true);
      }
      catch (e) {
         global.logError(e);
      }
   },

   _checkPaths: function(force) {
      force = force || false;
      
      this.openScreenshotsFolderItem.setSensitive(
         false != this._getCreateFolder(this._cameraSaveDir, force));

      this.openRecordingsFolderItem.setSensitive(
         false != this._getCreateFolder(this._recorderSaveDir, force));
   },

   _doRunHandler: function(uri, context) {
      try {
         Gio.app_info_launch_default_for_uri(uri,
            this._getLaunchContext(context));
      }
      catch (e) {
         global.log('Spawning xdg-open ' + uri);
         Util.spawn(['xdg-open', uri]);
      }
   },

   _openScreenshotsFolder: function() {
      this._doRunHandler('file://' + this._cameraSaveDir);
   },

   _openRecordingsFolder: function() {
      this._doRunHandler('file://' + this._recorderSaveDir);
   },

   /**
    * showSystemCursor:
    * Show the system mouse pointer.
    */
   showSystemCursor: function() {
     this._xfixesCursor.show();
   },

   /**
    * hideSystemCursor:
    * Hide the system mouse pointer.
    */
   hideSystemCursor: function() {
     this._xfixesCursor.hide();
   },

   indent: function(text) {
      if (this.actor.get_direction() == St.TextDirection.RTL) {
         return text + "  ";
      }
      else {
         return "  " + text;
      }
   },

   draw_menu: function(orientation) {
      this._customCommandItems = [];
      this.menuManager = new PopupMenu.PopupMenuManager(this);
      this.menu = new MyAppletPopupMenu(this, this.orientation, this._useTimer);
      this.menuManager.addMenu(this.menu);

      this._contentSection = new PopupMenu.PopupMenuSection();
      this.menu.addMenuItem(this._contentSection);

      // Honor user's choice between the new colored icon and the old one.
      if (this._useSymbolicIcon == 1) {
         this.set_applet_icon_symbolic_name("camera-photo-symbolic");
      }
      else {
         this.set_applet_icon_path(ICON_FILE);
      }

      if (this.has_camera()) {
         this._outputTitle = new TextImageMenuItem(_("Camera"), "camera-photo", false, "right", "sound-volume-menu-item");
         this.menu.addMenuItem(this._outputTitle);

         if (this.get_camera_program() == 'cinnamon') {
            this.menu.addAction(this.indent(_("Window")), Lang.bind(this, function(e) {
               return this.run_cinnamon_camera(Screenshot.SelectionType.WINDOW, e);
            }));
            this.menu.addAction(this.indent(_("Area")), Lang.bind(this, function(e) {
               return this.run_cinnamon_camera(Screenshot.SelectionType.AREA, e);
            }));
            this.menu.addAction(this.indent(_("Cinnamon UI")), Lang.bind(this, function(e) {
               return this.run_cinnamon_camera(Screenshot.SelectionType.CINNAMON, e);
            }));
            this.menu.addAction(this.indent(_("Screen")), Lang.bind(this, function(e) {
               return this.run_cinnamon_camera(Screenshot.SelectionType.SCREEN, e);
            }));

            if (Main.layoutManager.monitors.length > 1) {
               Main.layoutManager.monitors.forEach(function(monitor, index) {
                  this.menu.addAction(this.indent(_("Monitor %d").format(index + 1)), 
                   Lang.bind(this, function(e) {
                     return this.run_cinnamon_camera(Screenshot.SelectionType.MONITOR, e, index);
                  }));
                }, this);
            }

            // this.menu.addAction(this.indent(_("Interactive")), Lang.bind(this, function(e) {
            //    return this.run_cinnamon_camera(Screenshot.SelectionType.INTERACTIVE, e);
            // }));

            this._redoMenuItem = this.menu.addAction(this.indent(_("Redo last")), Lang.bind(this, this.redo_cinnamon_camera));
            
            if (this.lastCapture === null) {
               this._redoMenuItem.actor.hide();
            }

            // @todo add preview menu once preview app is finished
            //this.menu.addAction(this.indent(_("Preview last capture")), Lang.bind(this, function(e) {
            //}));
            
         }
         else {

            if (this.has_camera_support('window'))
            {
               this.menu.addAction(this.indent(_("Window")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('window'));
               }));
            }

            if (this.has_camera_support('window-section'))
            {
               this.menu.addAction(this.indent(_("Window section")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('window-section'));
               }));
            }

            if (this.has_camera_support('current-window'))
            {
               this.menu.addAction(this.indent(_("Current window")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('current-window'));
               }));
            }

            if (this.has_camera_support('area'))
            {
               this.menu.addAction(this.indent(_("Area")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('area'));
               }));
            }

            if (this.has_camera_support('screen'))
            {
               this.menu.addAction(this.indent(_("Entire screen")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('screen'));
               }));
            }

            if (this.has_camera_support('menu'))
            {
               this.menu.addAction(this.indent(_("Window menu")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('menu'));
               }));
            }

            if (this.has_camera_support('tooltip'))
            {
               this.menu.addAction(this.indent(_("Tooltip")), Lang.bind(this, function(e) {
                  this.Exec(this.get_camera_command('tooltip'));
               }));
            }

            if (this.has_camera_option('custom'))
            {
               let customOptions = this.get_camera_option('custom');

               for (var title in customOptions) {
                  this.addCustomCameraOption(title, customOptions[title]);

               }
            }
         }

         // OPTION: Include Cursor (toggle switch)
         let optionSwitch = new StubbornSwitchMenuItem(this.indent(_("Include cursor")), this._includeCursor, { style_class: 'bin' });
         optionSwitch.connect('toggled', Lang.bind(this, function(e1,v) {
            this._includeCursor = v;
            this.setSettingValue('include-cursor', v);
            
            if (this.get_camera_program() == CAMERA_PROGRAM_GNOME
             && null !== this._ssSettings) {
               // We can't pass a cursor option to gnome-screenshot,
               // so we modify its settings instead.
               this._ssSettings.set_boolean(KEY_GNOME_INCLUDE_CURSOR, v);
            }
            return false;
         }));
         this.menu.addMenuItem(optionSwitch);

         let timerSwitch = new StubbornSwitchMenuItem(this.indent(_("Use timer")), this._useTimer, { style_class: 'bin' });
         timerSwitch.connect('toggled', Lang.bind(this, function(e1,v) {
            this._useTimer = v;
            this.setSettingValue('use-timer', v);
            this.menu._animateClose = v; // Tell the menu not to animate while timer is off
            return false;
         }));
         this.menu.addMenuItem(timerSwitch);

         if (this.get_camera_program() == 'cinnamon') {
            if (this._showCopyToggle) {
               let copyDataSwitch = new StubbornSwitchMenuItem(this.indent(_("Copy image")), this._copyData, { style_class: 'bin' });
               copyDataSwitch.connect('toggled', Lang.bind(this, function(e1,v) {
                  this._copyData = v;
                  this.setSettingValue('copy-data', v);
                  return false;
               }));
               this.menu.addMenuItem(copyDataSwitch);
            }
            else {
               // Turn off our hidden setting since the UI can't.
               this._copyData = false;
               this.setSettingValue('copy-data', false);
            }

            if (this._showUploadToggle) {
               let uploadSwitch = new StubbornSwitchMenuItem(this.indent(_("Upload to imgur")), this._uploadToImgur, { style_class: 'bin' });
               uploadSwitch.connect('toggled', Lang.bind(this, function(e1,v) {
                  this._uploadToImgur = v;
                  this.setSettingValue('upload-to-imgur', v);
                  return false;
               }));
               this.menu.addMenuItem(uploadSwitch);
            }
            else {
               // Turn off our hidden setting since the UI can't.
               this._uploadToImgur = false;
               this.setSettingValue('upload-to-imgur', false);
            }
         }
      }

      /*if (this._uuid == 'capture-dev@rjanja') {
         this.menu.addAction(this.indent(_("Test Notification")), Lang.bind(this, function(e) {
            this._send_test_notification();
         }));
      }*/
      

      if (this.has_recorder())
      {
         if (this.has_camera()) {
            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
         }

         this._outputTitle2 = new TextImageMenuItem(_("Recorder"), "media-record", false, "right", "sound-volume-menu-item");
         this.menu.addMenuItem(this._outputTitle2);

         if (this.get_recorder_program() == 'cinnamon')
         {
             this._cRecorderItem = this.menu.addAction(this.indent(_("Start recording")), Lang.bind(this, this._toggle_cinnamon_recorder));
             // We could try to listen for when recording is activated
             // by keypress, but we wouldn't be able to differentiate
             // start vs. stop as it isn't exposed to us. So for now,
             // ignore it.
             //global.screen.connect('toggle-recording', Lang.bind(this, this._update_cinnamon_recorder_status));
         }
         else
         {
            if (this.has_recorder_option('custom'))
            {
               let customOptions = this.get_recorder_option('custom');

               if (this.has_recorder_option('-sound-on') && this.has_recorder_option('-sound-off')) {
                  let soundSwitch = new StubbornSwitchMenuItem(this.indent(_("Record sound")), this._recordSound, { style_class: 'bin' });
                  soundSwitch.connect('toggled', Lang.bind(this, function(e1,v) {
                     this._recordSound = v;
                     this.setSettingValue('record-sound', v);
                     
                     return false;
                  }));
                  this.menu.addMenuItem(soundSwitch);
               }

               if (this.has_recorder_option('controls')) {
                  let customControls = this.get_recorder_option('controls');
                  for (var control in customControls) {
                     this.addCustomRecorderControl(customControls[control]);
                  }
               }

               for (var title in customOptions) {
                  this.addCustomRecorderOption(title, title);
               }

               if (this.has_recorder_option('stop-command')){
                  this.menu.addAction(this.indent(_("Stop recording")), Lang.bind(this, function(actor, event) {
                     this.runCommand(this.get_recorder_option('stop-command'), 'recorder', false);
                  }));
               }

               this._redrawCustomMenus();

            }
         }
      }

      // Listen in for shift+clicks so we can alter our behavior accordingly.
      this.menu.actor.connect('key-press-event', Lang.bind(this, this._onMenuKeyPress));
      this.menu.actor.connect('key-release-event', Lang.bind(this, this._onMenuKeyRelease));
   },

   get_camera_filename: function(type) {
      let date = new Date();
      let prefix = this._cameraSavePrefix;

      if (type == undefined) {
         prefix = prefix.replace('%TYPE_', '');
         prefix = prefix.replace('%TYPE-', '');
         prefix = prefix.replace('%TYPE', '');
      }
      return this.replaceTokens(
         ['%Y',
         '%M',
         '%D',
         '%H',
         '%I',
         '%S',
         '%m',
         '%TYPE'],
         [date.getFullYear(),
         this._padNum(date.getMonth() + 1),
         this._padNum(date.getDate()),
         this._padNum(date.getHours()),
         this._padNum(date.getMinutes()),
         this._padNum(date.getSeconds()),
         this._padNum(date.getMilliseconds()),
         Screenshot.SelectionTypeStr[type]
         ],
         prefix);
   },

   get_recorder_filename: function(type) {
      let date = new Date();
      return this.replaceTokens(
         ['%Y',
         '%M',
         '%D',
         '%H',
         '%I',
         '%S',
         '%m',],
         [date.getFullYear(),
         this._padNum(date.getMonth() + 1),
         this._padNum(date.getDate()),
         this._padNum(date.getHours()),
         this._padNum(date.getMinutes()),
         this._padNum(date.getSeconds()),
         this._padNum(date.getMilliseconds())
         ],
         this._recorderSavePrefix);
   },

   _padNum: function(num) {
      return (num < 10 ? '0' + num : num);
   },

   redo_cinnamon_camera: function(event) {
      if (this.lastCapture) {
         let filename;
         try {
            filename = this._getCreateFilePath(this._cameraSaveDir, this.get_camera_filename(this.lastCapture.selectionType), 'png');
         }
         catch (e) {
            filename = false;
            global.log(e);
         }

         if (false == filename) {
            return false;
         }

         this.lastCapture.options.filename = filename;

         this.maybeCloseMenu();
         let camera = new Screenshot.ScreenshotHelper(null, null, this.lastCapture.options);

         switch (this.lastCapture.selectionType) {
            case Screenshot.SelectionType.WINDOW:
               camera.screenshotWindow(
                  this.lastCapture.window,
                  this.lastCapture.options);
               break;
            case Screenshot.SelectionType.AREA:
               camera.screenshotArea(
                  this.lastCapture.x,
                  this.lastCapture.y,
                  this.lastCapture.width,
                  this.lastCapture.height,
                  this.lastCapture.options);
               break;
            case Screenshot.SelectionType.CINNAMON:
               camera.screenshotCinnamon(
                  this.lastCapture.actor,
                  this.lastCapture.stageX,
                  this.lastCapture.stageY,
                  this.lastCapture.options);
               break;
         }
      }

      return true;
   },

   cinnamon_camera_complete: function(screenshot) {
      screenshot.uploaded = false;
      screenshot.uploadLinks = null;
      screenshot.extraActionMessage = '';

      this.lastCapture = screenshot;
      let copyToClipboard = this._copyData ? 4 : this._copyToClipboard;

      // We only support re-do of capture when we're using our own (for now)
      if (this.get_camera_program() == 'cinnamon')
      {
         if (this.lastCapture.selectionType != Screenshot.SelectionType.SCREEN) {
            this._redoMenuItem.actor.show();
         }
         else {
            this._redoMenuItem.actor.hide();
         }
      }
      if (this._copyData && this._copyDataAutoOff) {
         this._copyData = false;
         this.draw_menu();
      }
      else if (this._uploadToImgur && this._uploadAutoOff) {
         this.setSettingValue('upload-to-imgur', false);
         this._uploadToImgur = false;
         this.draw_menu();
      }

      var clipboardMessage = '';

      if (this._uploadToImgur && !screenshot.demo) {
         global.log('Uploading image to imgur..');
         this.uploadToImgur(screenshot.file, Lang.bind(this, function(success, json) {
            if (success) {
               screenshot.uploaded = true;
               screenshot.uploadLinks = json.links;

               screenshot.extraActionMessage = _('Screenshot has been uploaded as %s').format(json.links.original);

               if (copyToClipboard) {
                  St.Clipboard.get_default().set_text(json.links.original);
                  screenshot.clipboardMessage = _('Link has been copied to clipboard');
               }

               this.maybeSendNotification(screenshot);
            }
            else {
               screenshot.extraActionMessage = _('Screenshot could not be uploaded due to an error.');
            }
         }));

         return false;
      }
      else if (this._copyToClipboard) {
         if (ClipboardCopyType.PATH == copyToClipboard) {
            St.Clipboard.get_default().set_text(screenshot.file);
            clipboardMessage = _('Path has been copied to clipboard.');
         }
         else if (ClipboardCopyType.FILENAME == copyToClipboard) {
            St.Clipboard.get_default().set_text(screenshot.outputFilename);
            clipboardMessage = _('Filename has been copied to clipboard.');
         }
         else if (ClipboardCopyType.DIRECTORY == copyToClipboard) {
            St.Clipboard.get_default().set_text(screenshot.outputDirectory);
            clipboardMessage = _('Directory has been copied to clipboard.');
         }
         else if (ClipboardCopyType.IMAGEDATA == copyToClipboard
               && CLIPBOARD_HELPER) {
            this.runProgram('python ' + CLIPBOARD_HELPER + ' ' + screenshot.file);
            clipboardMessage = _('Image data has been copied to clipboard.');
         }
      }

      screenshot.clipboardMessage = clipboardMessage;

      this.maybeSendNotification(screenshot);

      

      // open-after is deprecated now that we have notification options
      /*if (screenshot.options.openAfter) {
         try {
            Gio.app_info_launch_default_for_uri('file://' + screenshot.outputDirectory,
               this._getLaunchContext(screenshot));
         }
         catch (e) {
            global.log('Spawning gvfs-open ' + screenshot.outputDirectory);
            Util.spawn(['gvfs-open', screenshot.outputDirectory]);
         }
      }*/
      
   },

   maybeSendNotification: function(screenshot) {
      if (screenshot.options.sendNotification) {
         let source = new Source('capture-rjanja', screenshot);
         Main.messageTray.add(source);

         // Load our icon into a texture for later use in notifications
         let icon_file = Gio.file_new_for_path(ICON_FILE_ACTIVE);
         let icon_uri = icon_file.get_uri();
         let icon_texture = St.TextureCache.get_default().load_uri_async(icon_uri, this._notificationIconSize, this._notificationIconSize);

         let image_file = Gio.file_new_for_path(screenshot.file);
         let image_uri = image_file.get_uri();
         let scaleFactor = St.ThemeContext.get_for_stage(global.stage).scale_factor;
         let image_texture = St.TextureCache.get_default().load_uri_sync(
            St.TextureCachePolicy.NONE,
            image_uri, 
            this._notificationImageSize, this._notificationImageSize, 
            scaleFactor);

         //global.tex = image_texture;

         let body = 'Screenshot has been saved to: \n' + image_file.get_parent().get_uri()
           + (screenshot.extraActionMessage ? "\n\n" + screenshot.extraActionMessage : "")
           + (screenshot.clipboardMessage ? "\n\n" + screenshot.clipboardMessage : "");

         let notification = new ScreenshotNotification(source,
            _("Screenshot captured!"), null,
            { body: body,
              customContent: true, bodyMarkup: true });
         notification.setResident(true);
         notification.setImage(image_texture);

         if (this._showDeleteAction) {
            notification.addButton('delete-file', _('Delete'));
         }

         if (this._showCopyDataAction) {
            notification.addButton('copy-data', _('Copy Data'));
         }

         if (this._showCopyPathAction) {
            notification.addButton('copy-path', _('Copy Path'));
         }

         if (screenshot.uploaded) {
            notification.addButton('open-link', _('Open Link'));
         }
         else if (this._showUploadAction) {
            notification.addButton('upload', _('Upload'));
         }

         //if (this._customActionLabel && this._customActionCmd) {
            //notification.addButton('custom', this._customActionLabel);
         //}

         notification.connect('action-invoked', Lang.bind(this, function(n, action_id) { 
            global.log('Action invoked from notification: ' + action_id);
            
            if (true == screenshot.demo) {
               n.setResident(false);
            }
            else {
               return this.handleNotificationResponse(screenshot, action_id, n);
            }
         }));

         notification.connect('image-left-clicked', Lang.bind(this, function(n, s) {
            this._doRunHandler('file://' + screenshot.file);
         }));

         if ('dismiss' != this._notificationBehavior) {
            let path = 'open-file' == this._notificationBehavior 
              ? screenshot.file : screenshot.outputDirectory;

            notification.connect('clicked', Lang.bind(this,
               function() {
                  this._doRunHandler('file://' + path);
            }));
         }

         source.notify(notification);
      }

      return true;
   },

   handleNotificationResponse: function(screenshot, action, notification) {
      if ('open-folder' == action) {
         this._doRunHandler('file://' + screenshot.outputDirectory);
      }
      else if ('open-file' == action) {
         this._doRunHandler('file://' + screenshot.file);
      }
      else if ('copy-data' == action) {
         this.runProgram('python ' + CLIPBOARD_HELPER + ' ' + screenshot.file);
      }
      else if ('copy-path' == action) {
         St.Clipboard.get_default().set_text(screenshot.file);
      }
      else if ('open-link' == action) {
         this._doRunHandler(screenshot.uploadLinks.imgur_page);
      }
      else if ('custom' == action) {
         this.runProgram(this._customActionCmd + ' ' + screenshot.file);
      }
      else if ('delete-file' == action && !screenshot.demo) {
         let file = Gio.file_new_for_path(screenshot.file);
         try {
            file.delete(null);
            /*notification.unsetImage();
            let box = new St.BoxLayout({ name: 'notification-actions' });
            notification.setActionArea(box, { row: 2, col: 1,
                                                      row_span: 1,
                                                      col_span: 2,
                                                      x_fill: false,
                                                      x_expand: false });*/
            let icon_file = Gio.file_new_for_path(ICON_FILE_ACTIVE);
            let icon_uri = icon_file.get_uri();
            let icon_texture = St.TextureCache.get_default().load_uri_async(icon_uri, this._notificationIconSize, this._notificationIconSize);

            notification.update('Screenshot deleted', _("The screenshot at %s was removed from disk.").format(screenshot.file),
               { body: _("The screenshot at %s was removed from disk.").format(screenshot.file),
                 icon: icon_texture, customContent: true, clear: true });

            Mainloop.timeout_add(1000, Lang.bind(this, function() {
               notification.destroy();
            }));
         }
         catch (e) {
            global.log(e);
            global.log("Could not delete file " + file.get_path());
         }

      }
      else if ('run-tools' == action) {
         // @wishlist better interactive post-capture tools
      }
      else if ('upload' == action && !screenshot.demo) {
         this.uploadToImgur(screenshot.file, Lang.bind(this, function(success, json) {
            if (success) {
               this._doRunHandler(json.links.imgur_page);

               if (screenshot.options.copyToClipboard) {
                  St.Clipboard.get_default().set_text(json.links.original);
                  clipboardMessage = _('Link has been copied to clipboard');
               }
            }
            else {
               screenshot.extraActionMessage = _('Screenshot could not be uploaded due to an error.');
            }
         }));
      }

      return true;
   },

   run_cinnamon_camera: function(type, event, index) {
      let enableTimer = (this._useTimer && this._delay > 0);

      let filename;
      try {
         filename = this._getCreateFilePath(this._cameraSaveDir, this.get_camera_filename(type), 'png');
      }
      catch (e) {
         filename = false;
         global.log(e);
      }

      if (false == filename) {
         return false;
      }

      let fnCapture = Lang.bind(this, function() {
         new Screenshot.ScreenshotHelper(type, Lang.bind(this, this.cinnamon_camera_complete),
         { 
            includeCursor: this._includeCursor,
            useFlash: this._useCameraFlash,
            includeFrame: this._includeWindowFrame,
            includeStyles: this._includeStyles,
            windowAsArea: this._windowAsArea,
            //copyToClipboard: this._copyData ? 4 : this._copyToClipboard,
            playShutterSound: this._playShutterSound,
            useTimer: enableTimer,
            playTimerSound: this._playIntervalSound,
            timerDuration: this._delay,
            soundTimerInterval: 'dialog-warning',
            soundShutter: 'camera-shutter',
            sendNotification: this._sendNotification,
            filename: filename,
            useIndex: index,
            openAfter: this._copyData ? false : this._openAfter,
            //clipboardHelper: CLIPBOARD_HELPER
         });
      });

      if (enableTimer || Screenshot.SelectionType.SCREEN != type) {
         fnCapture();
      }
      else {
         this.maybeCloseMenu();
         Mainloop.timeout_add(150, fnCapture);
      }
      return true;
   },

   maybeCloseMenu: function() {
      // Make sure we don't get our popup menu in the screenshot
      if (!this.useTimer) {
         this.menu.close(false);
      }
   },

   addCustomCameraOption: function(title, cmd) {
      this.menu.addAction(this.indent(title), Lang.bind(this, function(actor, event) {
         this.runCustomCommand(title, 'camera');
      }));
   },

   addCustomRecorderOption: function(title, cmd) {
      let menuItem = new PopupMenu.PopupMenuItem(title);
      this.menu.addMenuItem(menuItem);
      menuItem.connect('activate', Lang.bind(this, function (actor, event) {
         this.runCustomCommand(cmd, 'recorder');
      }));
      menuItem['_originalLabel'] = title;
      this._customCommandItems.push(menuItem);
   },

   _updateCustomSelect: function(o,evt,z,controlName, value) {
      let menuItems = this._customControls[controlName].menu._getMenuItems();
      for (var m in menuItems) {
         menuItems[m].setShowDot(menuItems[m]['_controlValue'] == value);
      }

      if (null !== this._updateCustomTimeoutId) {
         Mainloop.source_remove(this._updateCustomTimeoutId);
      }

      this._customSettings[controlName] = value;
      global.log('set ' + controlName + ' to value ' + value);
      this._updateCustomTimeoutId = Mainloop.timeout_add(500, Lang.bind(this, function() {
         this._redrawCustomMenus();
         this._updateCustomTimeoutId = null;
      }));
   
      return true;
   },

   _redrawCustomMenus: function() {
      global.log('redraw custom menus');
      for (var i in this._customControls) {
         this._customControls[i].label.set_text(this._parseCustom(this._customControls[i]['_originalLabel']));
      }

      for (var i in this._customCommandItems) {
         this._customCommandItems[i].label.set_text(this._parseCustom(this._customCommandItems[i]['_originalLabel']));
      }
   },

   _parseCustom: function(str) {
      for (var k in this._customSettings) {
         let repl = this._customSettings[k];
         str = str.replace('{' + k + '}', repl);
         str = str.replace('{' + k + '|UPPER}', repl.toUpperCase());
      }
      global.log(str);
      //newStr = this.applyCommandReplacements(str, 'recorder', options, false);
      return str;
   },

   addCustomRecorderControl: function(control) {
      switch (control['type']) {
         case 'select':
      // this.menu.addAction(this.indent(control['name']), Lang.bind(this, function(actor, event) {
      //    global.log("control clicked, var is " + control['var'])
      // }));
      this._customControls[control['var']] = new PopupMenu.PopupSubMenuMenuItem(this.indent(_(control['name'])), true);
      this._customControls[control['var']]['_originalLabel'] = control['name'];

      this.menu.addMenuItem(this._customControls[control['var']]);
      for (let i = 0; i < control['values'].length; i++) {
         let item = control['values'][i];
         //global.log(item['name']);
         let menuItem = new PopupMenu.PopupMenuItem(item['name']);
         menuItem['_controlValue'] = item['value'];
         if (item['value'] == control['default']) {
            menuItem.setShowDot(true);
            this._customSettings[control['var']] = item['value'];
         }
         menuItem.connect('activate', Lang.bind(this, this._updateCustomSelect, control['var'], item['value']));

         this._customControls[control['var']].menu.addMenuItem(menuItem);
      }

         break;
      }
   },

   _update_cinnamon_recorder_status: function(actor) {
      let label = this._cRecorderItem.actor.get_children()[0];
      let newLabel = "";

      if (this.cRecorder.is_recording()) {
         newLabel = "   " + _("Stop recording");
      }
      else {
         newLabel = "   " + _("Start recording");
      }

      label.set_text(newLabel);
   },

   _getCreateFolder: function(folderPath, dontCreate) {
      let folder = Gio.file_new_for_path(folderPath);

      if (true != folder.query_exists(null)) {
         try {
            if (dontCreate == false) {
               global.log("Save folder does not exist: " + folder.get_path() + ", aborting");
               return false;
            }

            folder.make_directory(null);
         }
         catch (e) {
            global.log("Save folder does not exist: " + folder.get_path() + ", aborting");
            return false;
         }
      }
      else {
         let fileType = folder.query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
         /* Don't restrict to only directories, just exclude normal files */
         if (Gio.FileType.REGULAR == fileType) {
            global.log("Cannot write to " + folder.get_path() + ", not a directory, aborting");
            return false;
         }
      }

      return true;
   },

   _getCreateFilePath: function(folderPath, fileName, fileExtension) {
      if (false == this._getCreateFolder(folderPath, false))
      {
         return false;
      }
      
      let file = Gio.file_new_for_path(folderPath + '/' + fileName + '.' + fileExtension);
      let desiredFilepath = file.get_path();
      try {
         if (file.create(Gio.FileCreateFlags.NONE, null)) {
            file.delete(null);
         }
         else {
            global.log("Could not create file " + file.get_path() + ", aborting");
            return false;
         }
      }
      catch (e) {
         global.log('Cannot open ' + desiredFilepath + ' for writing, aborting');
         return false;
      }

      return desiredFilepath;
   },

   _toggle_cinnamon_recorder: function(actor, event) {
      if (this.cRecorder.is_recording()) {
         this.cRecorder.pause();
         Meta.enable_unredirect_for_screen(global.screen);
      
         if (!this._useSymbolicIcon) {
            this.set_applet_icon_path(ICON_FILE);
         }
      }
      else {
         let filename;

         try {
            filename = this._getCreateFilePath(this._recorderSaveDir, this.get_recorder_filename(), this._crFileExtension);
         }
         catch (e) {
            filename = false;
            global.log(e);
         }

         if (false == filename) {
            global.log('no filename');
            return false;
         }

         this.cRecorder.set_filename(filename);
         global.log("Capturing screencast to " + filename);

         this.cRecorder.set_framerate(this._crFrameRate);

         let pipeline = this._crPipeline;
         global.log("Pipeline is " + pipeline);

         if (!pipeline.match(/^\s*$/))
            this.cRecorder.set_pipeline(pipeline);
         else
            this.cRecorder.set_pipeline(null);

         if (!this._useSymbolicIcon) {
            this.set_applet_icon_path(ICON_FILE_ACTIVE);
         }

         Meta.disable_unredirect_for_screen(global.screen);
         this.cRecorder.record();
      }

      this._update_cinnamon_recorder_status(actor);

      return true;
   },

   _launch_settings: function() {
      if (this._localSettings) {
         Main.Util.spawnCommandLine(AppletDir + "/settings.py");
      }
      else {
         Main.Util.spawnCommandLine('cinnamon-settings applets '+this._uuid);
      }
   },

   get_camera_program: function() {
      return this._cameraProgram;
   },

   has_camera_option: function(option) {
      return this.get_camera_options()[option] != undefined;
   },

   get_camera_option: function(option) {
      return this.get_camera_options()[option];
   },

   get_camera_options: function() {
      return this._programSupport['camera'][this.get_camera_program()];
   },

   get_camera_title: function() {
      return this.get_camera_option('title');
   },

   get_recorder_program: function() {
      return this._recorderProgram;
   },

   has_recorder_option: function(option) {
      return this.get_recorder_options()[option] != undefined
          && this.get_recorder_options()[option] !== false;
   },

   get_recorder_option: function(option) {
      return this.get_recorder_options()[option];
   },

   get_recorder_options: function() {
      return this._programSupport['recorder'][this.get_recorder_program()];
   },

   get_recorder_title: function() {
      return this.get_recorder_option('title');
   },

   has_camera: function() {
      return this._cameraProgram !== null;
   },

   has_recorder: function() {
      return this._recorderProgram !== null;
   },

   has_camera_support: function(fnType) {
      return this._cameraProgram !== null
        && 'supported' in this.get_camera_options()
        && this.get_camera_options()['supported'][fnType] != undefined;
   },

   get_camera_command: function (fnType) {
      let options = this.get_camera_options();
      let supported = this.get_camera_option('supported');

      if (fnType in supported)
      {
         let cmd = supported[fnType];
         if (cmd !== false && cmd !== null) {
            // @todo Move this elsewhere when consolidating execution
            this.maybeCloseMenu();
            return this.get_camera_program() + ' ' + this.applyCommandReplacements(cmd, 'camera', options, true);
         }
         else {
            return "";
         }
      }
      else {
         global.log("Not supported: " + fnType);
      }

      return "";
   },

   get_custom_camera_command: function (custom) {
      let options = this.get_camera_options();
      let cmd = options['custom'][custom];

      if (cmd) {
         return this.applyCommandReplacements(cmd, 'camera', options, false);
      }
      else {
         return "";
      }
   },

   get_custom_recorder_command: function(custom) {
      let options = this.get_recorder_options();
      let cmd = options['custom'][custom];

      if (cmd) {
         return this.applyCommandReplacements(cmd, 'camera', options, false);
      }
      else {
         return "";
      }
   },

   applyCommandReplacements: function(cmd, mode, options, appendCommand) {
      if (!options) {
         if (mode == 'camera') {
            options = this.get_camera_options();
         }
         else {
            options = this.get_recorder_options();
         }
      }

      let psCursorOn = options['-cursor-on'];
      let psCursorOff = options['-cursor-off'];
      let psAppend = options['-append'];
      let psCursorOn = options['-cursor-on'];
      let psCursorOff = options['-cursor-off'];
      
      let sCursor = "", sSound = "", sDelay = "", sDefaults = "";

      if (psCursorOn && this._includeCursor)
      {
         sCursor = psCursorOn;
      }
      else if (psCursorOff && !this._includeCursor)
      {
         sCursor = psCursorOff;
      }

      let psSoundOn = options['-sound-on'];
      let psSoundOff = options['-sound-off'];

      if (psSoundOn && this._recordSound) {
         sSound = psSoundOn;
      }
      else if (psSoundOff && !this._recordSound) {
         sSound = psSoundOff;
      }

      // Rather than repeating same options in support.json, they can
      // be made common to all capture modes for that application.
      if (psAppend && appendCommand == true) {
         cmd = cmd + ' ' + psAppend;
      }

      if (this._delay > 0)
      {
         sDelay = this._delay;
      }

      let sDimensions = global.screen_width + 'x' + global.screen_height;

      let replacements = {
         '{DELAY}': sDelay,
         '{CURSOR}': sCursor,
         '{SOUND}': sSound,
         '{DIRECTORY}': mode == 'camera' ? this._cameraSaveDir : this._recorderSaveDir,
         '{SCREEN_DIMENSIONS}': sDimensions,
         '{SCREEN_WIDTH}': global.screen_width,
         '{SCREEN_HEIGHT}': global.screen_height,
         '{RECORDER_DIR}': this._recorderSaveDir,
         '{SCREENSHOT_DIR}': this._cameraSaveDir,
         '{FILENAME}': mode == 'camera' ? this.get_camera_filename() : this.get_recorder_filename()
      };

      for (var k in replacements) {
         cmd = cmd.replace(k, replacements[k]);
      }

      return cmd;
   },

   runCommand: function(cmd, mode, isCapture) {
      cmd = this.applyCommandReplacements(cmd, mode);

      // When taking a capture, allow the use of the screenshot helper
      // for choosing window or making an area selection.
      let interactiveCallouts = {
         '#DC_WINDOW_HELPER#': Screenshot.SelectionType.WINDOW,
         '#DC_AREA_HELPER#': Screenshot.SelectionType.AREA
      };

      let helperMode = null;
      for (var k in interactiveCallouts) {
         if (cmd.indexOf(k) === 0) {
            if (isCapture == true) {
               helperMode = interactiveCallouts[k];
               global.log('Using screenshot helper from capture mode "' + Screenshot.SelectionTypeStr[helperMode] + '"');
            }

            cmd = cmd.replace(k,'');
            if (cmd.charAt(0)==' ') {
               cmd = cmd.substr(1);
            }
            break;
         }
      }

      this.maybeCloseMenu();

      if (isCapture == true) {
         if (null !== helperMode) {
            let ss = new Screenshot.ScreenshotHelper(helperMode, Lang.bind(this, function(vars) {
               global.res = vars;
               this.runInteractiveCustom(cmd, vars);
               
            }), { selectionHelper: true });
         }
         else {
            global.log('**FINAL CMD IS** '+cmd);
            this.TryExec(cmd, Lang.bind(this, this.onProcessSpawned),
               Lang.bind(this, this.onProcessError),
               Lang.bind(this, this.onProcessComplete));
         }
      }
      else {
         this.TryExec(cmd);
      }

      return false;
   },

   // @todo Separate out command-getting from command-parsing
   runCustomCommand: function(custom, mode, appendCommand) {
      let options;
      global.log('runCustom: ' + custom);
      if (mode == 'camera') {
         options = this.get_camera_options();
      }
      else {
         options = this.get_recorder_options();
      }
      
      let cmd = options['custom'][custom];

      if (!cmd) {
         return "";
      }

      // Rather than repeating same options in support.json, they can
      // be made common to all capture modes for that application.
      if (options['-append'] && appendCommand == true) {
         cmd = cmd + ' ' + psAppend;
      }

      if (mode == 'recorder') {
         cmd = this._parseCustom(cmd);
      }

      this.runCommand(cmd, mode, true);

      return false;
   },

   runInteractiveCustom: function(cmd, vars) {
      //global.log('runInteractiveCustom');
      let niceHeight = vars['height'] % 2 == 0 ? vars['height'] : vars['height'] + 1,
           niceWidth = vars['width']  % 2 == 0 ? vars['width']  : vars['width'] + 1;

      let replacements = {
         '{X}': vars['x'],
         '{Y}': vars['y'],
         '{X_Y}': vars['x']+','+vars['y'],
         '{WIDTH}': vars['width'],
         '{HEIGHT}': vars['height'],
         '{NICEWIDTH}': niceWidth,
         '{NICEHEIGHT}': niceHeight
      };

      if (vars['window']) {
         replacements['{X_WINDOW}'] = vars.window['x-window']; // Window frame
         replacements['{WM_CLASS}'] = vars.window.get_meta_window().get_wm_class();
         replacements['{WINDOW_TITLE}'] = vars.window.get_meta_window().get_title();
      }

      for (var k in replacements) {
         cmd = cmd.replace(k, replacements[k]);
      }

      global.log('**FINAL CMD IS** '+cmd);
      this.TryExec(cmd, Lang.bind(this, this.onProcessSpawned),
         Lang.bind(this, this.onProcessError),
         Lang.bind(this, this.onProcessComplete));
   },

   onProcessSpawned: function(pid) {
      if (!this._useSymbolicIcon) {
         this.set_applet_icon_path(ICON_FILE_ACTIVE);
      }
   },

   onProcessError: function(cmd) {
      if (!this._useSymbolicIcon) {
         this.set_applet_icon_path(ICON_FILE);
      }
      this.Exec('zenity --info --title="Desktop Capture" --text="Command exited with error status:\n\n'
         + '<span font_desc=\'monospace 10\'>' + cmd.replace('"', '\"') + '</span>"')
   },

   onProcessComplete: function(status, stdout) {
      if (!this._useSymbolicIcon) {
         this.set_applet_icon_path(ICON_FILE);
      }
      // @future Check status when we're able to (depends on Cinnamon)
      //this.Exec('zenity --info --title="Desktop Capture" --text="Command completed, output is:\n\n'
      //   + '<span font_desc=\'monospace 10\'>' + stdout.replace('"', '\"') + '</span>"')
   },

   get_program_available: function(program) {
      return this._programs[program] === true;
   },

   _set_program_available: function(program) {
      this._programs[program] = true;
   },

   _set_program_unavailable: function(program) {
      this._programs[program] = false;
   },

   _detect_program: function(program, i) {
      try {
         let [success, out, err, ret] = GLib.spawn_command_line_sync(program + ' --help', out, err, ret);
         this._set_program_available(program);
      }
      catch (e)
      {
         this._set_program_unavailable(program);
      }
   },

   detect_programs: function() {
      let programs = new Array();
      for (var type in this._programSupport) {
         for (var program in this._programSupport[type])
         {
            if (program != 'cinnamon') {
               programs.push(program);
            }
         }
      }

      programs.forEach(Lang.bind(this, this._detect_program));

      if (!this.get_program_available(this._cameraProgram))
      {
         this._recorderProgram = null;
         global.log(this._cameraProgram + ' is not available. Disabling camera functions.');
      }

      if (!this.get_program_available(this._recorderProgram)
          && this._recorderProgram != 'cinnamon')
      {
         this._recorderProgram = null;
         global.log('No screen recorder program is available. Disabling recorder functions.');
      }

      return programs.length;
   },

   Exec: function(cmd) {
      try {
         let success, argc, argv, pid, stdin, stdout, stderr;
         [success,argv] = GLib.shell_parse_argv(cmd);
         [success,pid,stdin,stdout,stderr] =
           GLib.spawn_async_with_pipes(null,argv,null,GLib.SpawnFlags.SEARCH_PATH,null,null);
      }
      catch (e)
      {
         global.log(e);
      }

      return true;
   },

   TryExec: function(cmd, onStart, onFailure, onComplete) {
      let success, argv, pid, in_fd, out_fd, err_fd;
      [success,argv] = GLib.shell_parse_argv(cmd);

      try {
         [success, pid, in_fd, out_fd, err_fd] = GLib.spawn_async_with_pipes(
            null,
            argv,
            null,
            GLib.SpawnFlags.SEARCH_PATH | GLib.SpawnFlags.DO_NOT_REAP_CHILD,
            null);
         }
      catch (e) {
         onFailure(cmd);
         return false;
      }
      if (success && pid != 0)
      {
         let out_reader = new Gio.DataInputStream({ base_stream: new Gio.UnixInputStream({fd: out_fd}) });
         // Wait for answer
         global.log("Created process, pid=" + pid);
         typeof onStart == 'function' && onStart(pid);
         GLib.child_watch_add( GLib.PRIORITY_DEFAULT, pid,
            function(pid,status) {
               GLib.spawn_close_pid(pid);
               global.log("Process completed, status=" + status);
               let [line, size, buf] = [null, 0, ""];
               while (([line, size] = out_reader.read_line(null)) != null && line != null) {
                  global.log(line);
                  global.log(size);
                  buf += line;
               }
               typeof onComplete == 'function' && onComplete(status, buf);
            });
      }
      else
      {
         global.log("Failed process creation");
         typeof onFailure == 'function' && onFailure(cmd);
      }

      return true;
   },

   on_applet_clicked: function(event) {
      this.menu.toggle();
   },

   _send_test_notification: function() {
      var enableTimer = (this._useTimer && this._delay > 0);
      var options = {
         includeCursor: this._includeCursor,
         useFlash: this._useCameraFlash,
         includeFrame: this._includeWindowFrame,
         includeStyles: this._includeStyles,
         windowAsArea: this._windowAsArea,
         //copyToClipboard: this._copyData ? 4 : this._copyToClipboard,
         playShutterSound: this._playShutterSound,
         useTimer: enableTimer,
         playTimerSound: this._playIntervalSound,
         timerDuration: this._delay,
         soundTimerInterval: 'dialog-warning',
         soundShutter: 'camera-shutter',
         sendNotification: this._sendNotification,
         filename: 'test.png',
         useIndex: 0,
         openAfter: this._copyData ? false : this._openAfter,
         //clipboardHelper: CLIPBOARD_HELPER
      };
      var screenshot = {
         selectionType: Screenshot.SelectionType.WINDOW,
         outputFilename: '',
         outputDirectory: '',
         file: '',
         uploadToImgur: this._uploadToImgur,
         options: options
      };

      this.cinnamon_camera_complete(screenshot);
   },

   on_config_demo_notification: function() {
      //return this._send_test_notification();

      var enableTimer = (this._useTimer && this._delay > 0);
      var options = {
         includeCursor: this._includeCursor,
         useFlash: this._useCameraFlash,
         includeFrame: this._includeWindowFrame,
         includeStyles: this._includeStyles,
         windowAsArea: this._windowAsArea,
         //copyToClipboard: this._copyData ? 4 : this._copyToClipboard,
         playShutterSound: this._playShutterSound,
         useTimer: enableTimer,
         playTimerSound: this._playIntervalSound,
         timerDuration: this._delay,
         soundTimerInterval: 'dialog-warning',
         soundShutter: 'camera-shutter',
         sendNotification: this._sendNotification,
         filename: 'test.png',
         useIndex: 0,
         openAfter: this._copyData ? false : this._openAfter,
         //clipboardHelper: CLIPBOARD_HELPER
      };
      var screenshot = {
         selectionType: Screenshot.SelectionType.WINDOW,
         outputFilename: 'desktop-capture.png',
         outputDirectory: this._cameraSaveDir,
         file: ICON_FILE,
         options: options,
         uploadToImgur: this._uploadToImgur,
         demo: true
      };

      this.cinnamon_camera_complete(screenshot);

      let timeoutId = Mainloop.timeout_add(3000, Lang.bind(this, function() {
         this.on_settings_changed();
      }));
    },

   on_applet_removed_from_panel: function() {
      // Applet roles introduced in Cinnamon 2.2
      this.maybeUnregisterRole();
   },

   replaceTokens: function(tokens, replacements, subject)
   {
      if (tokens.length == replacements.length) {
         var i, t, p, r;
         for (i = 0; i < tokens.length; i++) {
            t = tokens[i];
            r = replacements[i];
            while (-1 != (p = subject.indexOf(t))) {
               subject = subject.replace(t, r);
            }
         }
      }

      return subject;
   },

   maybeRegisterRole: function() {
      try {
         Main.systrayManager.registerRole("screenshot", this._uuid);
      }
      catch (e) {}
   },

   maybeUnregisterRole: function() {
      try {
         Main.systrayManager.unregisterRole("screenshot", this._uuid);
      }
      catch (e) {}
   },

   runProgram: function(cmd) {
      global.log('Running: ' + cmd);
      try {
         let success, argc, argv, pid, stdin, stdout, stderr;
         [success,argv] = GLib.shell_parse_argv(cmd);
         [success,pid,stdin,stdout,stderr] =
           GLib.spawn_async_with_pipes(null,argv,null,GLib.SpawnFlags.SEARCH_PATH,null,null);
      }
      catch (e)
      {
         global.log(e);
      }

      return true;
   },

   uploadToImgur: function(filename, callback) {
      let f = Gio.file_new_for_path(filename);
      let dir = f.get_parent().get_path();
      let imgLogFile = Gio.file_new_for_path(dir + '/imgur.log');
      let imgLog = imgLogFile.append_to(0, null);

      f.load_contents_async(null, function(f, res) {
         
         let contents;
         try {
            contents = f.load_contents_finish(res)[1];
         } catch (e) {
            global.log("*** ERROR: " + e.message);
            callback(false, null);
         }

         let buffer = new Soup.Buffer(contents, contents.length);
         let multiPart = new Soup.Multipart(Soup.FORM_MIME_TYPE_MULTIPART);
         
         multiPart.append_form_string('key', IMGUR_CRED);
         multiPart.append_form_file('image', filename, 'image/png', buffer);

         var message = Soup.form_request_new_from_multipart(
            'http://api.imgur.com/2/upload.json', multiPart);
         session.queue_message(message, function(session, response) {
            if (response.status_code !== 200) {
               global.log("Error during upload: response code " + response.status_code
                  + ": " + response.reason_phrase + " - " + response.response_body.data);
               callback(false, null);
               return true;
            }

            try {
               var imgur = JSON.parse(response.response_body.data);
               let imgurLinksText = 't=' + Main.formatTime(new Date(new Date().getTime()))
                 + ': ' + imgur.upload.links.imgur_page + ' ' 
                 + imgur.upload.links.delete_page + '\n';
               imgLog.write(imgurLinksText, null);
            }
            catch (e) {
               global.logError("Imgur seems to be down. Error was:");
               global.logError(e);
               callback(false, null);
               return true;
            }

            callback(true, imgur.upload);
            return true;
         });

         return true;
      }, null);
      
      return true;
   },
};

function main(metadata, orientation, panelHeight, instanceId) {
   Capture = imports.ui.appletManager.applets[metadata.uuid];
   Screenshot = Capture.screenshot;
   AppletDir = imports.ui.appletManager.appletMeta[metadata.uuid].path;
   //global.log(AppletDir);
   SUPPORT_FILE = AppletDir + '/support.json';
   ICON_FILE = AppletDir + '/desktop-capture.png';
   ICON_FILE_ACTIVE = AppletDir + '/desktop-capture-active.png';
   CLIPBOARD_HELPER = AppletDir + '/clip.py';

   let myApplet = new MyApplet(metadata, orientation, panelHeight, instanceId);
   return myApplet;
}