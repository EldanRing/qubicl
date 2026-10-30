# GTK modal activation without blocking accessibility

Status: accepted and implemented in the 0.8.1 development branch; verified in a
disposable Linux workstation with the actual GTK nested-modal fixture.

GTK3 can run a button callback synchronously inside its AT-SPI D-Bus handler.
A callback using `Gtk.Dialog.run()` then blocks that bridge: the visible dialog
and parent both become inaccessible. Making only the caller asynchronous does
not repair the application's blocked handler.

For GTK push-button `click` actions, choose a focused Space activation before
dispatch instead of issuing `DoAction`. Verify the target window/control focus,
modal state and held keys first. Report `dispatchMethod: focused_keyboard`,
null accessibility-API acceptance and unverified application effect. Never
replay an already dispatched semantic action through another mechanism.
Other toolkit/actions retain the AT-SPI path.

This changes focus as part of the requested activation. Revisit the workaround
when the deployed GTK bridge can execute a synchronous modal callback and remain
responsive to independent inspection of both windows. Keep passive observation
separate: do not alter application views or fabricate missing accessibility data.
