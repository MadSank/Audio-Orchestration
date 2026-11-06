Sources for the app's drawn art, and scripts for checking on the phone.

- `hand_sketch.js`: the pencil hand (`handFrame(seed)` points, `handFrame(seed, 'grip')` holds).
- `make_assets.py`, `grip_frames.py`: fonts, and the hand frames in `assets/hand/`. They render with Chrome.
- `icon_options.py`: the six icon ideas; `set_icon.py <png>` makes one the app's icon at every size.
  Finger is in use; Forever is kept in `assets/icon-options/`.
- `phone_*.py`: drive the app over adb and take screenshots. They only act while SAICS is in front.

Some paths are hard-coded to this machine, and the scripts look for their files beside themselves.
