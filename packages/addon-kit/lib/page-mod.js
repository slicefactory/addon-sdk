/* -*- Mode: Java; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

module.metadata = {
  "stability": "stable"
};

const observers = require("api-utils/observer-service");
const { Worker, Loader } = require('api-utils/content');
const { EventEmitter } = require('api-utils/events');
const { List } = require('api-utils/list');
const { Registry } = require('api-utils/utils/registry');
const { MatchPattern } = require('api-utils/match-pattern');
const { validateOptions : validate } = require('api-utils/api-utils');
const { validationAttributes } = require('api-utils/content/loader');
const { Cc, Ci } = require('chrome');
const { merge } = require('api-utils/utils/object');
const { readURISync } = require('api-utils/url/io');
const { windowIterator } = require("window-utils");
const { isBrowser } = require('api-utils/window/utils');
const { getTabs, getTabContentWindow, getTabForContentWindow,
        getURI: getTabURI } = require("api-utils/tabs/utils");

const styleSheetService = Cc["@mozilla.org/content/style-sheet-service;1"].
                            getService(Ci.nsIStyleSheetService);

const USER_SHEET = styleSheetService.USER_SHEET;

const io = Cc['@mozilla.org/network/io-service;1'].
              getService(Ci.nsIIOService);

// Valid values for `attachTo` option
const VALID_ATTACHTO_OPTIONS = ['existing', 'top', 'frame'];

// contentStyle* / contentScript* are sharing the same validation constraints,
// so they can be mostly reused, except for the messages.
const validStyleOptions = {
  contentStyle: merge(Object.create(validationAttributes.contentScript), {
    msg: 'The `contentStyle` option must be a string or an array of strings.'
  }),
  contentStyleFile: merge(Object.create(validationAttributes.contentScriptFile), {
    msg: 'The `contentStyleFile` option must be a local URL or an array of URLs'
  })
};

// rules registry
const RULES = {};

const Rules = EventEmitter.resolve({ toString: null }).compose(List, {
  add: function() Array.slice(arguments).forEach(function onAdd(rule) {
    if (this._has(rule))
      return;
    // registering rule to the rules registry
    if (!(rule in RULES))
      RULES[rule] = new MatchPattern(rule);
    this._add(rule);
    this._emit('add', rule);
  }.bind(this)),
  remove: function() Array.slice(arguments).forEach(function onRemove(rule) {
    if (!this._has(rule))
      return;
    this._remove(rule);
    this._emit('remove', rule);
  }.bind(this)),
});

/**
 * PageMod constructor (exported below).
 * @constructor
 */
const PageMod = Loader.compose(EventEmitter, {
  on: EventEmitter.required,
  _listeners: EventEmitter.required,
  attachTo: [],
  contentScript: Loader.required,
  contentScriptFile: Loader.required,
  contentScriptWhen: Loader.required,
  contentScriptOptions: Loader.required,
  include: null,
  constructor: function PageMod(options) {
    this._onContent = this._onContent.bind(this);
    options = options || {};

    let { contentStyle, contentStyleFile } = validate(options, validStyleOptions);

    if ('contentScript' in options)
      this.contentScript = options.contentScript;
    if ('contentScriptFile' in options)
      this.contentScriptFile = options.contentScriptFile;
    if ('contentScriptOptions' in options)
      this.contentScriptOptions = options.contentScriptOptions;
    if ('contentScriptWhen' in options)
      this.contentScriptWhen = options.contentScriptWhen;
    if ('onAttach' in options)
      this.on('attach', options.onAttach);
    if ('onError' in options)
      this.on('error', options.onError);
    if ('attachTo' in options) {
      if (typeof options.attachTo == 'string')
        this.attachTo = [options.attachTo];
      else if (Array.isArray(options.attachTo))
        this.attachTo = options.attachTo;
      else
        throw new Error('The `attachTo` option must be a string or an array ' +
                        'of strings.');

      let isValidAttachToItem = function isValidAttachToItem(item) {
        return typeof item === 'string' &&
               VALID_ATTACHTO_OPTIONS.indexOf(item) !== -1;
      }
      if (!this.attachTo.every(isValidAttachToItem))
        throw new Error('The `attachTo` option valid accept only following ' +
                        'values: '+ VALID_ATTACHTO_OPTIONS.join(', '));
      if (this.attachTo.indexOf("top") === -1 &&
          this.attachTo.indexOf("frame") === -1)
        throw new Error('The `attachTo` option must always contain at least' +
                        ' `top` or `frame` value');
    }
    else {
      this.attachTo = ["top", "frame"];
    }

    let include = options.include;
    let rules = this.include = Rules();
    rules.on('add', this._onRuleAdd = this._onRuleAdd.bind(this));
    rules.on('remove', this._onRuleRemove = this._onRuleRemove.bind(this));

    if (Array.isArray(include))
      rules.add.apply(null, include);
    else
      rules.add(include);

    let styleRules = "";

    if (contentStyleFile)
      styleRules = [].concat(contentStyleFile).map(readURISync).join("");

    if (contentStyle)
      styleRules += [].concat(contentStyle).join("");

    if (styleRules) {
      this._onRuleUpdate = this._onRuleUpdate.bind(this);

      this._styleRules = styleRules;

      this._registerStyleSheet();
      rules.on('add', this._onRuleUpdate);
      rules.on('remove', this._onRuleUpdate);
    }

    this.on('error', this._onUncaughtError = this._onUncaughtError.bind(this));
    pageModManager.add(this._public);

    this._loadingWindows = [];

    // `_applyOnExistingDocuments` has to be called after `pageModManager.add()`
    // otherwise its calls to `_onContent` method won't do anything.
    if ('attachTo' in options && options.attachTo.indexOf('existing') !== -1)
      this._applyOnExistingDocuments();
  },

  destroy: function destroy() {

    this._unregisterStyleSheet();

    this.include.removeListener('add', this._onRuleUpdate);
    this.include.removeListener('remove', this._onRuleUpdate);

    for each (let rule in this.include)
      this.include.remove(rule);
    pageModManager.remove(this._public);
    this._loadingWindows = [];

  },

  _loadingWindows: [],

  _applyOnExistingDocuments: function _applyOnExistingDocuments() {
    let mod = this;
    // Returns true if the tab match one rule
    function isMatchingURI(uri) {
      // Use Array.some as `include` isn't a native array
      return Array.some(mod.include, function (rule) {
        return RULES[rule].test(uri);
      });
    }
    getAllTabs().
      filter(function (tab) {
        return isMatchingURI(getTabURI(tab));
      }).
      forEach(function (tab) {
        // Fake a newly created document
        mod._onContent(getTabContentWindow(tab));
      });
  },

  _onContent: function _onContent(window) {
    // not registered yet
    if (!pageModManager.has(this))
      return;

    let isTopDocument = window.top === window;
    // Is a top level document and `top` is not set, ignore
    if (isTopDocument && this.attachTo.indexOf("top") === -1)
      return;
    // Is a frame document and `frame` is not set, ignore
    if (!isTopDocument && this.attachTo.indexOf("frame") === -1)
      return;

    // Immediatly evaluate content script if the document state is already
    // matching contentScriptWhen expectations
    let state = window.document.readyState;
    if ('start' === this.contentScriptWhen ||
        // Is `load` event already dispatched?
        'complete' === state ||
        // Is DOMContentLoaded already dispatched and waiting for it?
        ('ready' === this.contentScriptWhen && state === 'interactive') ) {
      this._createWorker(window);
      return;
    }

    let eventName = 'end' == this.contentScriptWhen ? 'load' : 'DOMContentLoaded';
    let self = this;
    window.addEventListener(eventName, function onReady(event) {
      if (event.target.defaultView != window)
        return;
      window.removeEventListener(eventName, onReady, true);

      self._createWorker(window);
    }, true);
  },
  _createWorker: function _createWorker(window) {
    let worker = Worker({
      window: window,
      contentScript: this.contentScript,
      contentScriptFile: this.contentScriptFile,
      contentScriptOptions: this.contentScriptOptions,
      onError: this._onUncaughtError
    });
    this._emit('attach', worker);
    let self = this;
    worker.once('detach', function detach() {
      worker.destroy();
    });
  },
  _onRuleAdd: function _onRuleAdd(url) {
    pageModManager.on(url, this._onContent);
  },
  _onRuleRemove: function _onRuleRemove(url) {
    pageModManager.off(url, this._onContent);
  },
  _onUncaughtError: function _onUncaughtError(e) {
    if (this._listeners('error').length == 1)
      console.exception(e);
  },
  _onRuleUpdate: function _onRuleUpdate(){
    this._registerStyleSheet();
  },

  _registerStyleSheet : function _registerStyleSheet() {
    let rules = this.include;
    let styleRules = this._styleRules;

    let documentRules = [];

    this._unregisterStyleSheet();

    for each (let rule in rules) {
      let pattern = RULES[rule];

      if (!pattern)
        continue;

      if (pattern.regexp)
        documentRules.push("regexp(\"" + pattern.regexp.source + "\")");
      else if (pattern.exactURL)
        documentRules.push("url(" + pattern.exactURL + ")");
      else if (pattern.domain)
        documentRules.push("domain(" + pattern.domain + ")");
      else if (pattern.urlPrefix)
        documentRules.push("url-prefix(" + pattern.urlPrefix + ")");
      else if (pattern.anyWebPage) {
        documentRules.push("regexp(\"^(https?|ftp)://.*?\")");
        break;
      }
    }

    let uri = "data:text/css;charset=utf-8,";
    if (documentRules.length > 0)
      uri += encodeURIComponent("@-moz-document " +
        documentRules.join(",") + " {" + styleRules + "}");
    else
      uri += encodeURIComponent(styleRules);

    this._registeredStyleURI = io.newURI(uri, null, null);

    styleSheetService.loadAndRegisterSheet(
      this._registeredStyleURI,
      USER_SHEET
    );
  },

  _unregisterStyleSheet : function () {
    let uri = this._registeredStyleURI;

    if (uri  && styleSheetService.sheetRegistered(uri, USER_SHEET))
      styleSheetService.unregisterSheet(uri, USER_SHEET);

    this._registeredStyleURI = null;
  }
});
exports.PageMod = function(options) PageMod(options)
exports.PageMod.prototype = PageMod.prototype;

const PageModManager = Registry.resolve({
  constructor: '_init',
  _destructor: '_registryDestructor'
}).compose({
  constructor: function PageModRegistry(constructor) {
    this._init(PageMod);
    observers.add(
      'document-element-inserted',
      this._onContentWindow = this._onContentWindow.bind(this)
    );
  },
  _destructor: function _destructor() {
    observers.remove('document-element-inserted', this._onContentWindow);
    this._removeAllListeners();
    for (let rule in RULES) {
      delete RULES[rule];
    }
    this._registryDestructor();
  },
  _onContentWindow: function _onContentWindow(document) {
    let window = document.defaultView;
    // XML documents don't have windows, and we don't yet support them.
    if (!window)
      return;
    // We apply only on documents in tabs of Firefox
    if (!getTabForContentWindow(window))
      return;

    for (let rule in RULES)
      if (RULES[rule].test(document.URL))
        this._emit(rule, window);
  },
  off: function off(topic, listener) {
    this.removeListener(topic, listener);
    if (!this._listeners(topic).length)
      delete RULES[topic];
  }
});
const pageModManager = PageModManager();

// Returns all tabs on all currently opened windows
function getAllTabs() {
  let tabs = [];
  // Iterate over all chrome windows
  for (let window in windowIterator()) {
    if (!isBrowser(window))
      continue;
    tabs = tabs.concat(getTabs(window));
  }
  return tabs;
}
