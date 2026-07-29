# Third-party notices

## serve-sim

Portions of SimView's SimulatorKit framebuffer and Indigo HID compatibility
work are adapted from [serve-sim](https://github.com/EvanBacon/serve-sim),
copyright Evan Bacon and contributors, licensed under Apache-2.0.

The adapted concepts and selector declarations are isolated under
`native/SimViewCore/Sources/SimViewCore/Compatibility`.

SimView does not contain or redistribute Argent binaries or proprietary source.

## IDB

Portions of SimView's host-side CoreSimulator accessibility translation flow
are adapted from [IDB](https://github.com/facebook/idb), copyright Meta
Platforms, Inc. and affiliates, licensed under the MIT License.

The adapted bridge is isolated in
`native/SimViewCore/Sources/SimViewAXShim`. SimView's injected UIKit probe is an
independent implementation and contains no Argent binary or proprietary code.
