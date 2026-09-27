# Floorp Tab Stack Improvements 
The tab stack implementation leaves a lot to be desired. They're clunky and frustrating to use. With the help of ~~vibecoding~~ Agentic Enginnering I've created a set of userscripts (and an optional stylesheet) to make tab stacks practical. The end goal is to make tab stacks as seamless and practical as global tabs, like Vivaldi. **The scripts and stylesheet are modular and self-contained, pick and choose what to add.**

# Bug Fixes

**stacktab-general-fixes.uc.js** - Fixes tab context menu entries showing only their icons, with no text, when the browser starts on a stack tab. Fixes a second window sometimes opening with its stacks turned into plain tab groups and no option to change them back.

**stacktab-global-drag-fix.uc.js** - Highly recommended. Fixes the dragging of stacks and tabs on the global tab bar. Tabs and stacks can be moved around smoothly without ordering and merge issues. Fixes tabs being merged with stacks when placed after it. Fixes stack tabs so they can be placed between stacks.

**floorp-sidebar-resize-fix.us.css** - Fixes unresizable sidebar when using some default Floorp themes.

# Recommended

**stacktab-mouse-improvements.uc.js** - Context-aware middle click on empty tab bar space to open a new tab. New tabs will open in the stack or global tabs depending on where you click, as well as drag and drop support for text/images/whatever. Dragging tabs from other windows aren't yet supported, but planned.

**stacktab-general-improvements.uc.js** - Makes stacks and stack tabs look and act more like global tabs. Shows the container color under stack tabs, adds the audio button with click to mute/unmute, shows the loading animation on loading stack tabs, moves the close button to the right side, removes the pointer cursor from stacks, remembers each stack's active tab across restarts, and closing or unloading a tab will prefer to switch to the left. It keeps you in its stack, group, or the global tabs whenever possible. Only when it was the last tab it will go to the nearest loaded tab elsewhere, and a neighbouring stack or group opens on its active tab instead of the "nearest".

**stacktab-hotkey-opens-in-stack.uc.js** - Makes the new tab hotkey & gesture context-aware. New tabs are opened in the currently active stack or in the global tab area, depending on which you're using.

**stacktab-inline-newtab-button.uc.js** - Moves the stack's new tab button to the right end of your tabs just like in the global area. It will snap to the window when the tabs overflow like global tabs.

**stacktab-overflow-scroll-speed.uc.js** - Scrolling overflowed tabs within a stack was frustratingly slow. This script makes scrolling behave like the global tabs.

**stacktab-drag-edge-scroll.uc.js** - Allows stack area to auto-scroll while dragging tabs to the edge. Also adds continuous scroll while holding left click on the arrows.

**stacktab-multiselect.uc.js** - Allows selecting multiple tabs from stacks. Useful with stacktab-move-to-group and stacktab-auto-title.

**stacktab-move-to-group-menu.uc.js** - Enables the "Add Tab to Group" option to stack tabs.

**stacktab-hover-preview.uc.js** - Replaces the tooltip with hover previews for stack tabs.
 
**stacktab-newtab-expand-animation.uc.js** - Adds the opening animation to stack tabs. Purely cosmetic but adds missing polish.

# Optional Features

**stacktab-auto-title.uc.js** - When you create a stack the "Manage Stack" options won't automatically appear and stacks will show the name and icon of their active tab. You can still change the name manually, makes stacks vivaldi-like, useful with stacktab-multiselect.uc.js and stacktab-move-to-group-menu.uc.js

**stacktab-close-confirm.uc.js** - Adds a dialog when closing a stack or group if it contains multiple tabs just like windows if "Ask before closing multiple tabs" is enabled in your settings.

**stacktab-unload-context-menu-item.uc.js** - Adds a context menu item for stacks and groups to unload the tabs they contain.

**stacktab-close-last-becomes-newtab.uc.js** - Makes closing the last tab in a stack switch to a new tab page instead of removing the stack. It still allows the stack to be closed on the stack handle itself. This mimics global window behavior. Useful for people who like to keep long-standing stacks and don't want to be careful about accidentally closing one.

**stacktab-auto-title-border.uc.css** - Gives stacks auto-titled by stacktab-auto-title.uc.js a border in your theme's text colour (light on dark themes, dark on light ones), so they stand out from stacks you've named.

**floorp-workspaces-scroll-switch.uc.js.** - Scroll over the workspaces button to quickly switch between them.

**floorp-about-page-singletons.uc.js** - This is the odd one out. It makes the Floorp hub a singleton like the rest of the about: pages. This makes them open in the global tabs and the browser will prefer to switch to existing hubs instead of opening a new one. Simply adds cohesion with the rest of Firefox.

**floorp-tab-marks.uc.js** - Adds a "Mark Tab" context menu entry to tabs that allows you to pick a color so you can keep track of it.

**stackktab-compact-stacks.uc.css** - Makes stacks a bit more compact, between the width of a group and normal tab. Great if you like to have a bunch of assorted stacks.

**stacktab-auto-title-border.uc.css** - Gives auto-titled stacks (from stacktab-auto-title.uc.js) a white or black border to differentiate them from named stacks.

# Installation

Install fx-autoconfig https://github.com/MrOtherGuy/fx-autoconfig then copy the JS folder and optionally userChrome.css to your profile -> chrome folder (you'll know where it is after installing fx-autoconfig). Delete unwanted scripts as you wish.
