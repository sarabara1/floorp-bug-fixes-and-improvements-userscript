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

The same list, in the same order, as on the settings page. Sub-settings are listed under their feature.

### Bug Fixes (on by default)

Fixes for bugs in Floorp's tab stacks, tab bar, workspaces and sidebar.

- **Stack-aware drag and drop**: Tabs and stacks move around the tab bar smoothly without accidentally merging into stacks. Tabs can move between stacks, tabs from other windows can join a stack, and links, text and files can be dropped onto a stack or its tabs.
- **Double new tab button**: Fixes a random startup bug where the new tab button appears twice and dragging tabs stops working.
- **Tab menu text on startup**: Fixes the tab menu showing only icons, with no text, when the browser starts on a stack tab.
- **Stacks in new windows**: Fixes new windows sometimes opening with their stacks turned into plain tab groups.
- **Resizable sidebar**: Lets the sidebar be made much wider on themes that limit its width.
- **Stacks copied into another workspace**: Fixes stacks showing up in two workspaces at once after one of their tabs was moved to another workspace or reopened. A moved tab now leaves its stack, a reopened tab stays out of other workspaces' stacks, and stacks already split this way become one stack in each workspace.
- **Reopened tabs go back to their workspace**: Reopening a closed tab brings it back to the workspace it was closed in, and into its stack, and switches to that workspace.
- **Moved stacks keep their tab**: A stack moved to another window opens on the tab you were using in it, instead of its first or last tab.

### Stack Improvements (on by default)

Make stacks and the tabs inside them look and behave like normal tabs.

- **Container colors**: Stack tabs in a container show the container's colored line, like normal tabs.
- **Audio button**: Stack tabs and stacks show the speaker button while playing sound. Click it to mute or unmute.
- **Loading animation**: Stack tabs show the loading animation while their page loads.
- **Normal tab buttons**: Stack tabs and stacks have their close button at the right end, keep their icon visible on hover, and use the normal pointer, like normal tabs.
- **Remember each stack's tab**: Clicking a stack opens the tab you last used in it, even after a restart.
- **Stay in the stack when closing tabs**: Closing or unloading a tab, or moving it to another workspace, switches to the nearest loaded tab in the same stack or group, or among the normal tabs. If none is left there, it goes to the nearest one outside, and a stack opens on the tab you last used in it.
  - *Go to the tab on the left* (on by default): Looks for the next tab on the left first. Turn off to look on the right first.
- **Middle-click for a new tab**: Middle-click empty space on the tab bar to open a new tab, or empty space in a stack to open one in that stack.
- **Ctrl+T opens in the stack**: Ctrl+T and the new tab mouse gesture open the tab where you are: in the stack you're using, or with your normal tabs when you're not in one.
  - *Also in tab groups* (on by default): The same for tab groups: in a tab group, Ctrl+T and the mouse gesture open the tab in that group.
- **Bookmarks open in the stack**: Bookmarks and history entries opened in new tabs, including whole folders, go into the stack you're using.
  - *Also in tab groups* (on by default): Bookmarks opened in new tabs also go into the tab group you're using.
- **Stack + button beside the tabs**: A stack's + button sits right after its tabs, like on the main tab bar, and moves to the edge when the tabs don't fit.
- **Container menu on the stack + button**: Right-click or hold a stack's + button to open a new tab in a container in that stack, like the main tab bar's + button. If containers are set to open on a left-click, a left-click works too.
- **Middle-click the main + for a normal tab**: Middle-clicking the main tab bar's + button opens a normal tab at the end of the tab bar.
- **Faster wheel scrolling**: Scrolling a stack's tabs with the mouse wheel is as fast and smooth as on the main tab bar.
- **Auto-scroll while dragging**: A stack's tabs scroll when you drag something to their edge, like the main tab bar.
  - *Hold the arrows to scroll* (on by default): Holding down a stack's scroll arrow keeps scrolling, like the main tab bar.
- **Select several stack tabs**: Ctrl-click and Shift-click select several stack tabs at once. Dragging, the tab menu and anything else that works on selected tabs then applies to all of them.
- **Add Tab to Group for stack tabs**: Stack tabs get the "Add Tab to Group" menu item, to move a tab straight into another stack or group. A new group made from a stack tab appears right after its stack.
- **Hover previews**: Hovering a stack tab shows the tab preview card, like normal tabs, and hovering a stack shows just its name.
- **New tab animation**: New stack tabs grow open like normal tabs.
- **Keep the current tab in view**: When a stack has more tabs than fit, they scroll to keep the tab you're on in view, including new tabs and the tab you land on after closing one, like the main tab bar.

### Stack Features (off by default)

Optional changes to how stacks behave.

- **Auto-title stacks**: Unnamed stacks show the title of the tab you're using in them, and new stacks skip the naming popup. Naming a stack shows its name again; clearing the name brings the title back.
  - *Show the tab's icon* (on by default): Also shows that tab's icon, and its loading animation, in place of the stack symbol.
- **Tab icons on named stacks**: Named stacks show the icon of the tab you're using in them, and its loading animation, in place of the stack symbol.
- **Confirm closing stacks**: Asks before closing a stack or group with more than one tab.
- **Unload Stack menu item**: Adds "Unload Stack" and "Unload Group" to a stack's or group's menu, to unload all its tabs.
- **Move Stack to Another Workspace**: Adds "Move Stack to Another Workspace" and "Move Group to Another Workspace" to a stack's or group's menu, to send it with all its tabs to another workspace while you stay where you are.
- **Keep stacks when their last tab closes**: Closing the last tab in a stack leaves a new tab page in it, so the stack stays.

### Appearance (off by default)

Optional style changes.

- **Theme-matched stack colors**: New stacks start white on dark themes and gray on light ones, and White is added to the colors for stacks and groups.
- **Compact stacks**: Stacks take up less room than normal tabs, so more of them fit in the tab bar. A stack whose name doesn't fit grows to show it, up to a normal tab's width.
  - *Full width for auto-titled stacks* (off by default): With Auto-title stacks on, auto-titled stacks are as wide as a normal tab, while named stacks stay compact.

### Browser (off by default)

Improvements that aren't specific to stacks.

- **Tab marks**: Adds "Mark Tab" to the tab menu to give tabs, including stack tabs, a colored border so they're easy to find. Works on several selected tabs, and marks are kept after a restart.
  - *Ask before closing marked tabs* (off by default): Asks before closing a marked tab. When closing several tabs at once, you can keep the marked ones and close the rest.
- **Scroll to switch workspaces**: Scroll the mouse wheel over the Workspaces button to switch workspaces, stopping at the first and last.
- **One Floorp Hub and Settings tab**: Floorp Hub and Settings each open in only one tab, with the normal tabs; opening them again switches to that tab.

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
