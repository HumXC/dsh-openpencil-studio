# Third-party reuse notice

This package depends on @zseven-w/dsh-openpencil 0.1.0-rc.13 as code only. It does not execute that package's plugin apply(), default generation controller, prompt registration or reference skill.

Seven narrowly scoped source modules were reused from that exact package. Their original SHA-256 values and source/target paths are recorded in [vendor-manifest.json](vendor-manifest.json). [scripts/vendor-official.mjs](scripts/vendor-official.mjs) performs the copy; [scripts/editor-patches.mjs](scripts/editor-patches.mjs) applies Studio-specific transport, lifecycle, snapshot, recovery and revision-safe save hooks. Runtime/process shims use private Studio directories instead of the official shared profile state. The native editor application, assets and binaries are provided by the upstream dependency, not copied into this package's source tree.

Internal upstream modules lib/editor-runtime.js and lib/editor-recovery.js are adapted separately. Their internal paths and native RPC / document CAS / browser bridge protocols are version-sensitive dependencies, not claimed public APIs.

## Upstream MIT license

Copyright (c) 2026 ZSeven—W

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
