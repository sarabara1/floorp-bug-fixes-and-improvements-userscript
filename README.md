# Floorp Bug Fixes & Improvements

Floorp is buggy, and its tab stacks leave a lot to be desired: they're clunky and frustrating to use. This script fixes bugs, makes stacks look and behave like normal tabs (much like Vivaldi's tab stacks), and adds some useful extra features.

It's a single file. Every feature can be turned on or off on its own from a built-in settings page, and changes apply right away, with no restart.

# Using it

Open the settings page from any of these:
- **Tools → Floorp Bug Fixes & Improvements** in the menu bar (press Alt if it's hidden)
- right-click the tab bar → **Floorp Bug Fixes & Improvements**
- the toolbar button, which you can add from **Customize Toolbar**

On the page:
- **Turn features on or off** with the switch next to each one. Bug fixes and stack improvements are on by default; the other features are off until you turn them on. Some features have extra options nested under them, which only work while the main feature is on.
- **Search** for a feature, or jump between categories on the left.
- **Reset to defaults** puts every switch back to how it started.
- Your choices apply to every open window and are kept across restarts.

**If something breaks.** If a Floorp update breaks a feature, only that feature stops; everything else keeps working. The settings page marks it *Failed to load*, *Unavailable*, *Partly working* or *Errors*, and the menu entries show how many features have problems. Click **Details** to see what went wrong and **Try again**, or use **Copy diagnostics** to include the details in a bug report.

**Updates.** The script checks GitHub for a newer version every 12 hours. You can turn that off, or check now, at the top of the settings page. When there's an update, the settings page says so with a link to get it, and the menu entries show "(Update available)". It only tells you; replacing the file is up to you (see *Updating* below).

**Turning everything off.** To turn every feature off without uninstalling, set `uc.floorp-improvements.paused` to `true` in `about:config`. The settings page stays available, so you can turn it back on from there.

# Features

### Bug fixes (on by default)

- **Stack-aware drag and drop**: tabs and stacks move around the tab bar smoothly without accidentally merging into stacks. Tabs can go between stacks, tabs from other windows can join a stack, and links, text and files can be dropped onto a stack or the tabs inside it.
- **Double new tab button**: fixes a random startup bug where the new tab button shows up twice and dragging tabs breaks until a restart.
- **Tab menu text on startup**: fixes the tab context menu showing only icons, with no text, when the browser starts on a stack tab.
- **Stacks in new windows**: fixes a second window sometimes opening with its stacks turned into plain tab groups, with no way to change them back.
- **Resizable sidebar**: lets the sidebar be made much wider on Floorp themes that restrict it.
- **Stacks copied into another workspace**: moving one tab of a stack to another workspace, or reopening a closed tab, could make the stack show up in both workspaces as a linked copy. Now a moved tab leaves on its own as a normal tab, and stacks that are already split this way become two separate stacks, one in each workspace.
- **Reopened tabs go back to their workspace**: reopening a closed tab (Ctrl+Shift+T or Recently Closed Tabs) brings it back to the workspace it was closed in, and into its stack if it was in one, and switches to that workspace.

### Stack improvements (on by default)

These make stacks and the tabs inside them look and behave like normal tabs.

- **Container colors**: stack tabs in a container show its colored line, like normal tabs.
- **Audio button**: stack tabs, and stacks themselves, show the speaker button when playing sound. Click it to mute or unmute.
- **Loading animation**: stack tabs show the loading animation while their page loads.
- **Normal tab buttons**: the close button sits at the right end of stack tabs and stacks, the favicon stays visible on hover, and stacks keep the normal arrow cursor.
- **Remember each stack's tab**: clicking a stack opens the tab you last viewed in it, even after a restart.
- **Stay in the stack when closing tabs**: closing or unloading a tab, or moving it to another workspace, switches to the nearest loaded tab beside it, staying in its stack or group unless it was the last tab there.
  - *Go to the tab on the left*: try the tab on the left first (turn off to try the right first).
- **Middle-click for a new tab**: middle-click empty space on the tab bar to open a new tab. Empty space in a stack opens it in that stack.
- **Ctrl+T opens in the stack**: the new tab shortcut and mouse gesture open the tab in the stack you're using. The + buttons are unchanged.
  - *Also in tab groups*: the same for tab groups.
- **Bookmarks open in the stack**: bookmarks and history entries opened in a new tab (middle-click, Ctrl+click, Open in New Tab, or a whole folder) go in the stack you're using.
  - *Also in tab groups*: the same for tab groups.
- **Stack + button beside the tabs**: a stack's new tab button sits at the end of its tabs, like on the main tab bar, and moves to the edge when the tabs overflow.
- **Container menu on the stack + button**: right-click a stack's + button, or hold it down, to open a new tab in a container, like the main tab bar's + button. If Firefox is set to show the container menu on a left-click, that works too. Only when containers are turned on.
- **Middle-click the main + for a normal tab**: middle-clicking the main tab bar's + opens a normal tab at the end, instead of a tab in the active stack.
- **Faster wheel scrolling**: scrolling a stack's overflowing tabs with the mouse wheel is as fast and smooth as on the main tab bar.
- **Auto-scroll while dragging**: a stack's tabs scroll when you drag a tab to the edge.
  - *Hold the arrows to scroll*: holding a scroll arrow keeps scrolling.
- **Select several stack tabs**: Ctrl-click and Shift-click select several stack tabs. Dragging, the tab menu and everything else that works on selected tabs then works on all of them.
- **Add Tab to Group for stack tabs**: stack tabs get the "Add Tab to Group" menu item, so a tab can go straight into another stack or group.
- **Hover previews**: hovering a stack tab shows Firefox's tab preview card, following Firefox's own setting. Stack tooltips show just the stack's name.
- **New tab animation**: new stack tabs grow open like normal tabs, instead of popping in.
- **Keep the current tab in view**: when a stack has more tabs than fit, its tabs scroll to show the tab you switch to (including after closing a tab) and new tabs, like the main tab bar. A tab opened in the background is only scrolled to if the tab you're on stays in view.

### Stack features (off by default)

- **Auto-title stacks**: unnamed stacks show the title of the tab you're using in them, and new stacks skip the naming popup. Name a stack to turn it off for that stack; clear the name to bring it back.
  - *Show the tab's icon* (on): auto-titled stacks also show that tab's icon instead of the stack symbol.
  - *Full width* (off, needs Compact stacks): auto-titled stacks stay a full tab's width while named stacks stay compact.
- **Tab icons on named stacks**: named stacks show the icon of the tab you're using in them instead of the stack symbol.
- **Confirm closing stacks**: closing a stack or group with more than one tab asks first.
- **Unload Stack menu item**: adds "Unload Stack" / "Unload Group" to a stack's or group's menu, to unload every tab in it.
- **Move Stack to Another Workspace**: adds "Move Stack to Another Workspace" / "Move Group to Another Workspace" to a stack's or group's menu.
- **Keep stacks when their last tab closes**: closing the last tab in a stack leaves a new tab page there instead of removing the stack. Closing the stack itself still works.

### Appearance (off by default)

- **Theme-matched stack colors**: new stacks start white on dark themes and gray on light ones, instead of a random color, and White is added to the colors you can pick for stacks and groups.
- **Compact stacks**: stacks are only as wide as their name (at least 150px). Handy if you keep lots of stacks.

### Browser (off by default)

- **Tab marks**: adds "Mark Tab" to the tab menu to give tabs (normal or in stacks) a colored border, so they're easy to keep track of. Marks survive restarts.
  - *Ask before closing marked tabs* (off): closing a marked tab asks first. When closing several tabs at once, you can keep the marked ones and close the rest.
- **Scroll to switch workspaces**: scroll the mouse wheel over the Workspaces button to switch workspaces. It stops at the first and last one instead of wrapping around.
- **One Floorp Hub and Settings tab**: Floorp Hub and Settings open only once, with the normal tabs, and switch to the open tab instead of opening a duplicate.

# Installation

The script runs through [fx-autoconfig](https://github.com/MrOtherGuy/fx-autoconfig), a small loader for Firefox-based browsers.

### 1. Install fx-autoconfig

Download fx-autoconfig (**Code → Download ZIP** on its GitHub page) and extract it. It has two parts:

**Program files**: copy the contents of its `program` folder into the folder that contains the Floorp executable:

| OS | Floorp folder |
|---|---|
| Windows | `C:\Program Files\Ablaze Floorp\` |
| macOS | `Floorp.app/Contents/Resources/` |
| Linux | the folder with the `floorp` binary (e.g. `/usr/lib/floorp/`) |

You should end up with `config.js` next to the Floorp executable and `config-prefs.js` in its `defaults/pref/` folder. On Windows this needs administrator rights.

**Profile files**: open `about:support` in Floorp, find **Profile Folder** and click **Open Folder**. Copy the `chrome` folder from fx-autoconfig's `profile` folder into it. You should end up with:

```
<profile>/chrome/
├── CSS/
├── JS/
└── utils/
```

### 2. Add the script

Copy `floorp-bug-fixes-and-improvements.uc.js` from this repo's `JS` folder into your Floorp profile's `chrome/JS/` folder.

If you used the older separate scripts from this repo (`stacktab-*.uc.js`, `floorp-*.uc.js` and the `.uc.css` files), delete them. Until you do, the features they cover are skipped, and the settings page lists the files to remove.

### 3. Restart Floorp

Open the hamburger menu and click **Restart → Restart with Cache Clear**. Do this every time you add, remove or update the script, or the browser may keep running the old version.

# Updating

Download the new `floorp-bug-fixes-and-improvements.uc.js` (the settings page links to it when an update is available), replace the old file in `chrome/JS/`, then restart with **Restart with Cache Clear**. Your settings are kept.

# Removing

Delete the script from `chrome/JS/`, then restart with **Restart with Cache Clear** again.
