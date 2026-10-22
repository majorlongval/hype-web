# Browser controls

Choose **Modern keyboard + mouse** before Play, or open **Controls** in the game's top bar. Settings are remembered in this browser. The Controls panel pauses the game. **Original keyboard** restores pass-through keyboard input and turns browser mouse controls off.

The modern preset assumes the game's default English/QWERTY bindings. If you previously rebound actions in the game's Configuration → Controls menu, restore its defaults or choose Original keyboard.

| Action | Modern control | Original prompt |
| --- | --- | --- |
| Move / turn | WASD or arrows | Arrows |
| Jump | Space | Left Ctrl |
| Interact / attack / select in menus | E or left click | Space |
| Run | Hold Shift | Shift |
| Look / aim | Hold right mouse and move; or C + arrows | Numpad 0 / Ins + arrows |
| Sword / crossbow | Q / R | X / Z |
| Select magic | F or mouse wheel | Delete |
| Cast magic | G or middle click | Enter |
| Sidestep left / right | Z / X | A / S |
| Inventory / map | Tab / M | Tab / End |

A/D turn the character. While look mode is held, the game interprets directional keys as view/aim adjustments. Shift remains available for the game's precision-aim mode.

For player names, enable **Typing** in the top bar or press the backtick key. Letters and Space then pass through normally. Turn Typing off to resume the preset. Original tutorial text can still show the old keys; the Controls panel includes their equivalents.

## Mouse prototype

Right-drag translates mouse movement into short presses of the game's original look directions while holding its numpad-zero look modifier. It does not modify the game executable or implement a free camera. Sensitivity controls the duration of these directional inputs, not a native camera angle. The camera's original speed limits still apply.

The browser requests pointer lock while the right button is held, allowing movement beyond screen edges. Releasing the button restores the pointer. If pointer lock is unavailable, right-drag works while pointer events remain available. Escape exits pointer lock. Losing focus, opening Controls, changing presets, or entering Typing mode releases held inputs. Keyboard and mouse inputs are tracked separately, so releasing one does not cancel an action held by the other.

Mouse movement/aiming is experimental and needs playtesting across levels, weapons, and camera states. Native mouse-driven camera support has not been established. Mobile touch controls are not provided.
