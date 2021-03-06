/* vim:set ts=2 sw=2 sts=2 expandtab */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

module.metadata = {
  "stability": "experimental"
};

const { Cc, Ci } = require('chrome');
const { descriptor, Sandbox, evaluate, main, resolveURI } = require('api-utils/loader');
const { once } = require('../system/events');
const { exit, env, staticArgs, name } = require('../system');
const { when: unload } = require('../unload');
const { loadReason } = require('self');
const { rootURI } = require("@loader/options");
const globals = require('../globals');

const NAME2TOPIC = {
  'Firefox': 'sessionstore-windows-restored',
  'Fennec': 'sessionstore-windows-restored',
  'SeaMonkey': 'sessionstore-windows-restored',
  'Thunderbird': 'mail-startup-done',
  '*': 'final-ui-startup'
};

// Gets the topic that fit best as application startup event, in according with
// the current application (e.g. Firefox, Fennec, Thunderbird...)
const APP_STARTUP = NAME2TOPIC[name] || NAME2TOPIC['*'];

// Initializes default preferences
function setDefaultPrefs(prefsURI) {
  const prefs = Cc['@mozilla.org/preferences-service;1'].
                getService(Ci.nsIPrefService).
                QueryInterface(Ci.nsIPrefBranch2);
  const branch = prefs.getDefaultBranch('');
  const sandbox = Sandbox({
    name: prefsURI,
    prototype: {
      pref: function(key, val) {
        switch (typeof val) {
          case 'boolean':
            branch.setBoolPref(key, val);
            break;
          case 'number':
            if (val % 1 == 0) // number must be a integer, otherwise ignore it
              branch.setIntPref(key, val);
            break;
          case 'string':
            branch.setCharPref(key, val);
            break;
        }
      }
    }
  });
  // load preferences.
  evaluate(sandbox, prefsURI);
}

function definePseudo(loader, id, exports) {
  let uri = resolveURI(id, loader.mapping);
  loader.modules[uri] = { exports: exports };
}

function wait(reason, options) {
  once(APP_STARTUP, function() {
    startup(null, options);
  });
}

function startup(reason, options) {
  if (reason === 'startup')
    return wait(reason, options);

  // Inject globals ASAP in order to have console API working ASAP
  Object.defineProperties(options.loader.globals, descriptor(globals));

  // Load localization manifest and .properties files.
  // Run the addon even in case of error (best effort approach)
  require('api-utils/l10n/loader').
    load(rootURI).
    then(null, function failure(error) {
      console.info("Error while loading localization: " + error.message);
    }).
    then(function onLocalizationReady(data) {
      // Exports data to a pseudo module so that api-utils/l10n/core
      // can get access to it
      definePseudo(options.loader, '@l10n/data', data);
      run(options);
    });
}

function run(options) {
  try {
    // Try initializing HTML localization before running main module. Just print
    // an exception in case of error, instead of preventing addon to be run.
    try {
      // Do not enable HTML localization while running test as it is hard to
      // disable. Because unit tests are evaluated in a another Loader who
      // doesn't have access to this current loader.
      if (options.main !== 'test-harness/run-tests')
        require('api-utils/l10n/html').enable();
    }
    catch(error) {
      console.exception(error);
    }
    // Initialize inline options localization, without preventing addon to be
    // run in case of error
    try {
      require('api-utils/l10n/prefs');
    }
    catch(error) {
      console.exception(error);
    }

    // TODO: When bug 564675 is implemented this will no longer be needed
    // Always set the default prefs, because they disappear on restart
    setDefaultPrefs(options.prefsURI);

    // this is where the addon's main.js finally run.
    let program = main(options.loader, options.main);

    if (typeof(program.onUnload) === 'function')
      unload(program.onUnload);

    if (typeof(program.main) === 'function') {

      program.main({
        loadReason: loadReason,
        staticArgs: staticArgs 
      }, { 
        print: function print(_) { dump(_ + '\n') },
        quit: exit 
      });
    }
  } catch (error) {
    console.exception(error);
    throw error;
  }
}
exports.startup = startup;

// If add-on is lunched via `cfx run` we need to use `system.exit` to let
// cfx know we're done (`cfx test` will take care of exit so we don't do
// anything here).
if (env.CFX_COMMAND === 'run') {
  unload(function(reason) {
    if (reason === 'shutdown')
      exit(0);
  });
}
