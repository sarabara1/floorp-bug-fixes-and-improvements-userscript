# Floorp Bug Fixes & Improvements

The browser is buggy and the tab stack implementation leaves a lot to be desired. They're clunky and frustrating to use. This script aims to fix bugs, improve stacks, and add useful features.

It has a settings page for turning each feature one on or off. Open it from **Tools → Floorp Bug Fixes & Improvements**, by right-clicking the tab bar, or by using the toolbar button you can add from **Customize Toolbar**. Changes apply right away, no restart needed.

- Bug fixes and the recommended improvements are on by default, the optional features will need to be enabled manually.
- If a Floorp update breaks a feature, only that feature stops. The settings page marks it *Failed to load*, *Unavailable* or *Errors*, shows the error, and has *Try again* and *Copy diagnostics* buttons. The menu entries also show how many features have problems.
- It checks GitHub for a newer version every 12 hours (you can turn that off, or check now, at the top of the settings page). When there is one, the settings page says so with a link to get it, and the menu entries show "(Update available)". It only tells you; replacing the file is up to you.

# Installation

The script runs through [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig), a small loader for Firefox-based browsers.

### 1. Install fx-autoconfig

Download fx-autoconfig (**Code → Download ZIP** on its GitHub page) and extract it. It has two parts:

**Program files** — copy the contents of its `program` folder into the folder that contains the Floorp executable:

| OS | Floorp folder |
|---|---|
| Windows | `C:\Program Files\Ablaze Floorp\` |
| macOS | `Floorp.app/Contents/Resources/` |
| Linux | the folder with the `floorp` binary (e.g. `/usr/lib/floorp/`) |

You should end up with `config.js` next to the Floorp executable and `config-prefs.js` in its `defaults/pref/` folder. On Windows this needs administrator rights.

**Profile files** — open `about:support` in Floorp, find **Profile Folder** and click **Open Folder**. Copy the `chrome` folder from fx-autoconfig's `profile` folder into it. You should end up with:

```
<profile>/chrome/
├── CSS/
├── JS/
└── utils/
```

### 2. Add the script

- Copy the `floorp-bug-fixes-and-improvements.uc.js` file from this repo's `JS` folder to your Floorp profiles's `chrome/JS/` folder.

### 3. Restart Floorp

Open the hamburger menu and click **Restart > Restart with Cache Clear**. Do this every time you add, remove, or update the script, or the browser may keep running the old version.

### Removing a script

Delete the script from `chrome/JS/` and clear restart with the cache clear again.