// A control cannot pick its own metrics: `.ui-btn` carries height, type size and
// icon size, and every interactive element in the app wears it. This is the icon
// size it expects, so a new control sizes its icons from here rather than by eye.
export const ICON = 14;
