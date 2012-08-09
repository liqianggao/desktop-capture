Desktop Capture<a name="top">&nbsp;</a>
===============
A comprehensive screenshot and screencasting applet for Cinnamon.

![Applet configured for Cinnamon Screenshot and Recorder](https://raw.github.com/rjanja/desktop-capture/master/img/cinnamon-screenshot.png?login=rjanja&token=2b7eea0e4cbd049e2760a9d9a2c83b3a "Applet configured for Cinnamon Screenshot and Recorder")

### Intro<a name="intro">&nbsp;</a>
This project started because I wanted a simple way to choose and switch between capture software packages. I consider screen capture to be one of the more important utilities mostly ignored (inaccessible, featureless) in both Unity and GNOME Shell.

My favorite capture software has always been Shutter, but when I found it wouldn't behave with Cinnamon I decided to write an Cinnamon-specific screenshot class and integrate it into Desktop Capture. So while <i>Cinnamon Screenshot</i> comes with this applet, you are free to use any capture software you like. Shutter will continue to be supported because it is still a great tool.

### Features<a name="features">&nbsp;</a>
* Built-in capture tool: Full screen, Window, Area, and Cinnamon UI capture modes. More to come.
* Also compatible with GNOME-Screenshot, Shutter, xwd and most other capture tools that have command line interfaces.
* Options for changing most configuration settings; further customisations are possible via JSON support file - add custom capture entries to compose a menu that works for you. Additional options for controlling screen recorder (frames per second and GStreamer pipeline).
* Timer delay with optional onscreen countdown and interval sound.

![Applet settings](https://raw.github.com/rjanja/desktop-capture/master/img/cinnamon-screenshot-settings.png?login=rjanja&token=d3758a887e24592e1fdc1163782facd0 "Applet settings")

### Installation<a name="installing">&nbsp;</a>
* Check out source with git, then run `./install-schema.sh`, move `capture@rjanja` folder into `~/.local/share/cinnamon/applets/`, restart Cinnamon and add applet normally
* To use the built-in Cinnamon Screenshot, a patch must first be applied to Cinnamon: [linuxmint/Cinnamon#1016](https://github.com/linuxmint/Cinnamon/pull/1016)

### Still to come<a name="wishlist">&nbsp;</a>
* Automatic upload to imgur
* Improved area selection tool
* Instructions overlay
* Pre- and post-capture dialogs (interactive mode)

### Adding program support<a name="extending">&nbsp;</a>
A number of program-specific options can be set for your preferred capture program by manually editing the `support.json` file. New programs can be added by creating a new block, just remember not to use trailing commas on the last elements and do not try to add comments as they seem to break the parser.

![Extending](https://raw.github.com/rjanja/desktop-capture/master/img/custom-entries.png?login=rjanja&token=3d94754ee03361f082dbe6e82e774b82 "Extending program support")

For camera/screenshot programs, a standard set of "supported" features can be enabled. If they are missing, or set to false, they will be considered to be disabled/not present. Custom options can be supplied which will appear after the standard supported options, with the key being the text that shall be shown and the value being the full command to run, including the executable name.

For recorder/screencast programs, there is no similar list of "supported" features; only "custom" entries are used here.

### Thanks
* The Linux Mint development team and contributors for all of their efforts!
* infektedpc, who developed the very first screenshot applet for Cinnamon (as a teenager!)
* Ben Scholzen, author of Shell's Area Screenshot extension, from which area selection and timer have been integrated.
* The author(s) of Shell's capture backend.
* GNOME for all their work adding some really great features we can all enjoy, despite some misguided attempts to remove features we still use.