/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const { keyPress } = require("api-utils/dom/events/keys");
const { Loader } = require("test-harness/loader");
const timer = require("timer");

exports["test unload keyboard observer"] = function(assert, done) {
  let loader = Loader(module);
  let element = loader.require("api-utils/window-utils").
                       activeBrowserWindow.document.documentElement;
  let observer = loader.require("api-utils/keyboard/observer").
                        observer;
  let called = 0;

  observer.on("keypress", function () { called++; });

  // dispatching "keypress" event to trigger observer listeners.
  keyPress(element, "accel-%");

  // Unload the module.
  loader.unload();

  // dispatching "keypress" even once again.
  keyPress(element, "accel-%");

  // Enqueuing asserts to make sure that assertion is not performed early.
  timer.setTimeout(function () {
    assert.equal(called, 1, "observer was called before unload only.");
    done();
  }, 0);
};

require("test").run(exports);
