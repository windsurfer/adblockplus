/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Adblock Plus.
 *
 * The Initial Developer of the Original Code is
 * Wladimir Palant.
 * Portions created by the Initial Developer are Copyright (C) 2006-2010
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *
 * ***** END LICENSE BLOCK ***** */

/**
 * @fileOverview Manages synchronization of filter subscriptions.
 */

var EXPORTED_SYMBOLS = ["Synchronizer"];

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cr = Components.results;
const Cu = Components.utils;

let baseURL = Cc["@adblockplus.org/abp/private;1"].getService(Ci.nsIURI);

Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import(baseURL.spec + "TimeLine.jsm");
Cu.import(baseURL.spec + "Utils.jsm");
Cu.import(baseURL.spec + "FilterStorage.jsm");
Cu.import(baseURL.spec + "FilterClasses.jsm");
Cu.import(baseURL.spec + "SubscriptionClasses.jsm");
Cu.import(baseURL.spec + "Prefs.jsm");

const MILLISECONDS_IN_SECOND = 1000;
const SECONDS_IN_MINUTE = 60;
const SECONDS_IN_HOUR = 60 * SECONDS_IN_MINUTE;
const SECONDS_IN_DAY = 24 * SECONDS_IN_HOUR;
const INITIAL_DELAY = 6 * SECONDS_IN_MINUTE;
const CHECK_INTERVAL = SECONDS_IN_HOUR;
const MIN_EXPIRATION_INTERVAL = 1 * SECONDS_IN_DAY;
const MAX_EXPIRATION_INTERVAL = 14 * SECONDS_IN_DAY;
const MAX_ABSENSE_INTERVAL = 1 * SECONDS_IN_DAY;

var XMLHttpRequest = Components.Constructor("@mozilla.org/xmlextras/xmlhttprequest;1", "nsIJSXMLHttpRequest");

let timer = null;

/**
 * Map of subscriptions currently being downloaded, all currently downloaded
 * URLs are keys of that map.
 */
let executing = {__proto__: null};

/**
 * This object is responsible for downloading filter subscriptions whenever
 * necessary.
 * @class
 */
var Synchronizer =
{
  /**
   * Called on module startup.
   */
  startup: function()
  {
    TimeLine.enter("Entered Synchronizer.startup()");
  
    let callback = function()
    {
      timer.delay = CHECK_INTERVAL * MILLISECONDS_IN_SECOND;
      checkSubscriptions();
    };
  
    timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    timer.initWithCallback(callback, INITIAL_DELAY * MILLISECONDS_IN_SECOND, Ci.nsITimer.TYPE_REPEATING_SLACK);
  
    TimeLine.leave("Synchronizer.startup() done");
  },

  /**
   * Checks whether a subscription is currently being downloaded.
   * @param {String} url  URL of the subscription
   * @return {Boolean}
   */
  isExecuting: function(url)
  {
    return url in executing;
  },

  /**
   * Starts the download of a subscription.
   * @param {DownloadableSubscription} subscription  Subscription to be downloaded
   * @param {Boolean} manual  true for a manually started download (should not trigger fallback requests)
   * @param {Boolean}  forceDownload  if true, the subscription will even be redownloaded if it didn't change on the server
   */
  execute: function(subscription, manual, forceDownload)
  {
    let url = subscription.url;
    if (url in executing)
      return;

    let newURL = subscription.nextURL;
    let hadTemporaryRedirect = false;
    subscription.nextURL = null;

    let curVersion = Utils.addonVersion;
    let loadFrom = newURL;
    let isBaseLocation = true;
    if (!loadFrom)
      loadFrom = url;
    if (loadFrom == url)
    {
      if (subscription.alternativeLocations)
      {
        // We have alternative download locations, choose one. "Regular"
        // subscription URL always goes in with weight 1.
        let options = [[1, url]];
        let totalWeight = 1;
        for each (let alternative in subscription.alternativeLocations.split(','))
        {
          if (!/^https?:\/\//.test(alternative))
            continue;

          let weight = 1;
          let weightingRegExp = /;q=([\d\.]+)$/;
          if (weightingRegExp.test(alternative))
          {
            weight = parseFloat(RegExp.$1);
            if (isNaN(weight) || !isFinite(weight) || weight < 0)
              weight = 1;
            if (weight > 10)
              weight = 10;

            alternative = alternative.replace(weightingRegExp, "");
          }
          options.push([weight, alternative]);
          totalWeight += weight;
        }

        let choice = Math.random() * totalWeight;
        for each (let [weight, alternative] in options)
        {
          choice -= weight;
          if (choice < 0)
          {
            loadFrom = alternative;
            break;
          }
        }

        isBaseLocation = (loadFrom == url);
      }
    }
    else
    {
      // Ignore modification date if we are downloading from a different location
      forceDownload = true;
    }
    loadFrom = loadFrom.replace(/%VERSION%/, "ABP" + curVersion);

    let request = null;
    function errorCallback(error)
    {
      let channelStatus = -1;
      try
      {
        channelStatus = request.channel.status;
      } catch (e) {}
      let responseStatus = "";
      try
      {
        responseStatus = request.channel.QueryInterface(Ci.nsIHttpChannel).responseStatus;
      } catch (e) {}
      setError(subscription, error, channelStatus, responseStatus, loadFrom, isBaseLocation, manual);
    }

    try
    {
      request = new XMLHttpRequest();
      request.mozBackgroundRequest = true;
      request.open("GET", loadFrom);
    }
    catch (e)
    {
      errorCallback("synchronize_invalid_url");
      return;
    }

    try {
      request.overrideMimeType("text/plain");
      request.channel.loadFlags = request.channel.loadFlags |
                                  request.channel.INHIBIT_CACHING |
                                  request.channel.VALIDATE_ALWAYS;

      // Override redirect limit from preferences, user might have set it to 1
      if (request.channel instanceof Ci.nsIHttpChannel)
        request.channel.redirectionLimit = 5;

      var oldNotifications = request.channel.notificationCallbacks;
      var oldEventSink = null;
      request.channel.notificationCallbacks =
      {
        QueryInterface: XPCOMUtils.generateQI([Ci.nsIInterfaceRequestor, Ci.nsIChannelEventSink]),

        getInterface: function(iid)
        {
          if (iid.equals(Ci.nsIChannelEventSink))
          {
            try {
              oldEventSink = oldNotifications.QueryInterface(iid);
            } catch(e) {}
            return this;
          }
    
          return (oldNotifications ? oldNotifications.QueryInterface(iid) : null);
        },

        // Old (Gecko 1.9.x) version
        onChannelRedirect: function(oldChannel, newChannel, flags)
        {
          if (isBaseLocation && !hadTemporaryRedirect && oldChannel instanceof Ci.nsIHttpChannel)
          {
            try
            {
              subscription.alternativeLocations = oldChannel.getResponseHeader("X-Alternative-Locations");
            }
            catch (e)
            {
              subscription.alternativeLocations = null;
            }
          }

          if (flags & Ci.nsIChannelEventSink.REDIRECT_TEMPORARY)
            hadTemporaryRedirect = true;
          else if (!hadTemporaryRedirect)
            newURL = newChannel.URI.spec;

          if (oldEventSink)
            oldEventSink.onChannelRedirect(oldChannel, newChannel, flags);
        },

        // New (Gecko 2.0) version
        asyncOnChannelRedirect: function(oldChannel, newChannel, flags, callback)
        {
          this.onChannelRedirect(oldChannel, newChannel, flags);
      
          // If onChannelRedirect didn't throw an exception indicate success
          callback.onRedirectVerifyCallback(Cr.NS_OK);
        }
      }
    }
    catch (e)
    {
      Cu.reportError(e)
    }

    if (subscription.lastModified && !forceDownload)
      request.setRequestHeader("If-Modified-Since", subscription.lastModified);

    request.onerror = function(ev)
    {
      delete executing[url];
      try {
        request.channel.notificationCallbacks = null;
      } catch (e) {}

      errorCallback("synchronize_connection_error");
    };

    request.onload = function(ev)
    {
      delete executing[url];
      try {
        request.channel.notificationCallbacks = null;
      } catch (e) {}

      // Status will be 0 for non-HTTP requests
      if (request.status && request.status != 200 && request.status != 304)
      {
        errorCallback("synchronize_connection_error");
        return;
      }

      let newFilters = null;
      if (request.status != 304)
      {
        newFilters = readFilters(subscription, request.responseText, errorCallback);
        if (!newFilters)
          return;

        subscription.lastModified = request.getResponseHeader("Last-Modified");
      }

      if (isBaseLocation && !hadTemporaryRedirect)
        subscription.alternativeLocations = request.getResponseHeader("X-Alternative-Locations");
      subscription.lastSuccess = subscription.lastDownload = Math.round(Date.now() / MILLISECONDS_IN_SECOND);
      subscription.downloadStatus = "synchronize_ok";
      subscription.errors = 0;

      // Expiration header is relative to server time - use Date header if it exists, otherwise local time
      let now = Math.round((new Date(request.getResponseHeader("Date")).getTime() || Date.now()) / MILLISECONDS_IN_SECOND);
      let expires = Math.round(new Date(request.getResponseHeader("Expires")).getTime() / MILLISECONDS_IN_SECOND) || 0;
      let expirationInterval = (expires ? expires - now : 0);
      for each (let filter in newFilters || subscription.filters)
      {
        if (filter instanceof CommentFilter && /\bExpires\s*(?::|after)\s*(\d+)\s*(h)?/i.test(filter.text))
        {
          let interval = parseInt(RegExp.$1);
          if (RegExp.$2)
            interval *= SECONDS_IN_HOUR;
          else
            interval *= SECONDS_IN_DAY;

          if (interval > expirationInterval)
            expirationInterval = interval;
        }
        if (isBaseLocation && filter instanceof CommentFilter && /\bRedirect(?:\s*:\s*|\s+to\s+|\s+)(\S+)/i.test(filter.text))
          subscription.nextURL = RegExp.$1;
      }

      // Expiration interval should be within allowed range
      expirationInterval = Math.min(Math.max(expirationInterval, MIN_EXPIRATION_INTERVAL), MAX_EXPIRATION_INTERVAL);

      // Hard expiration: download immediately after twice the expiration interval
      subscription.expires = (subscription.lastDownload + expirationInterval * 2);

      // Soft expiration: use random interval factor between 0.8 and 1.2
      subscription.softExpiration = (subscription.lastDownload + Math.round(expirationInterval * (Math.random() * 0.4 + 0.8)));

      if (isBaseLocation && newURL && newURL != url)
      {
        let listed = (subscription.url in FilterStorage.knownSubscriptions);
        if (listed)
          FilterStorage.removeSubscription(subscription);

        url = newURL;

        let newSubscription = Subscription.fromURL(url);
        for (let key in newSubscription)
          delete newSubscription[key];
        for (let key in subscription)
          newSubscription[key] = subscription[key];

        delete Subscription.knownSubscriptions[subscription.url];
        newSubscription.oldSubscription = subscription;
        subscription = newSubscription;
        subscription.url = url;

        if (!(subscription.url in FilterStorage.knownSubscriptions) && listed)
          FilterStorage.addSubscription(subscription);
      }

      if (newFilters)
        FilterStorage.updateSubscriptionFilters(subscription, newFilters);
      else
        FilterStorage.triggerSubscriptionObservers("updateinfo", [subscription]);
      delete subscription.oldSubscription;

      FilterStorage.saveToDisk();
    };

    executing[url] = true;
    FilterStorage.triggerSubscriptionObservers("updateinfo", [subscription]);

    try
    {
      request.send(null);
    }
    catch (e)
    {
      delete executing[url];
      errorCallback("synchronize_connection_error");
      return;
    }
  }
};

/**
 * Checks whether any subscriptions need to be downloaded and starts the download
 * if necessary.
 */
function checkSubscriptions()
{
  let hadDownloads = false;
  let time = Math.round(Date.now() / MILLISECONDS_IN_SECOND);
  for each (let subscription in FilterStorage.subscriptions)
  {
    if (!(subscription instanceof DownloadableSubscription) || !subscription.autoDownload)
      continue;

    if (subscription.lastCheck && time - subscription.lastCheck > MAX_ABSENSE_INTERVAL)
    {
      // No checks for a long time interval - user must have been offline, e.g.
      // during a weekend. Increase soft expiration to prevent load peaks on the
      // server.
      subscription.softExpiration += time - subscription.lastCheck;
    }
    subscription.lastCheck = time;

    // Sanity check: do expiration times make sense? Make sure people changing
    // system clock don't get stuck with outdated subscriptions.
    if (subscription.expires - time > MAX_EXPIRATION_INTERVAL)
      subscription.expires = time + MAX_EXPIRATION_INTERVAL;
    if (subscription.softExpiration - time > MAX_EXPIRATION_INTERVAL)
      subscription.softExpiration = time + MAX_EXPIRATION_INTERVAL;

    if (subscription.softExpiration > time && subscription.expires > time)
      continue;

    // Do not retry downloads more often than synchronizationinterval pref dictates
    let interval = (time - subscription.lastDownload) / SECONDS_IN_HOUR;
    if (interval >= Prefs.synchronizationinterval)
    {
      hadDownloads = true;
      Synchronizer.execute(subscription, false);
    }
  }

  if (!hadDownloads)
  {
    // We didn't kick off any downloads - still save changes to lastCheck & Co.
    FilterStorage.saveToDisk();
  }
}

/**
 * Extracts a list of filters from text returned by a server.
 * @param {DownloadableSubscription} subscription  subscription the info should be placed into
 * @param {String} text server response
 * @param {Function} errorCallback function to be called on error
 * @return {Array of Filter}
 */
function readFilters(subscription, text, errorCallback)
{
  let lines = text.split(/[\r\n]+/);
  if (!/\[Adblock(?:\s*Plus\s*([\d\.]+)?)?\]/i.test(lines[0]))
  {
    errorCallback("synchronize_invalid_data");
    return null;
  }
  let minVersion = RegExp.$1;

  for (let i = 0; i < lines.length; i++)
  {
    if (/!\s*checksum[\s\-:]+([\w\+\/]+)/i.test(lines[i]))
    {
      lines.splice(i, 1);
      let checksumExpected = RegExp.$1;
      let checksum = Utils.generateChecksum(lines);

      if (checksum && checksum != checksumExpected)
      {
        errorCallback("synchronize_checksum_mismatch");
        return null;
      }

      break;
    }
  }

  delete subscription.requiredVersion;
  delete subscription.upgradeRequired;
  if (minVersion)
  {
    subscription.requiredVersion = minVersion;
    if (Utils.versionComparator.compare(minVersion, Utils.addonVersion) > 0)
      subscription.upgradeRequired = true;
  }

  lines.shift();
  let result = [];
  for each (let line in lines)
  {
    let filter = Filter.fromText(Filter.normalize(line));
    if (filter)
      result.push(filter);
  }

  return result;
}

/**
 * Handles an error during a subscription download.
 * @param {DownloadableSubscription} subscription  subscription that failed to download
 * @param {Integer} channelStatus result code of the download channel
 * @param {String} responseStatus result code as received from server
 * @param {String} downloadURL the URL used for download
 * @param {String} error error ID in global.properties
 * @param {Boolean} isBaseLocation false if the subscription was downloaded from a location specified in X-Alternative-Locations header
 * @param {Boolean} manual  true for a manually started download (should not trigger fallback requests)
 */
function setError(subscription, error, channelStatus, responseStatus, downloadURL, isBaseLocation, manual)
{
  // If download from an alternative location failed, reset the list of
  // alternative locations - have to get an updated list from base location.
  if (!isBaseLocation)
    subscription.alternativeLocations = null;

  try {
    Cu.reportError("Adblock Plus: Downloading filter subscription " + subscription.title + " failed (" + Utils.getString(error) + ")\n" +
                   "Download address: " + downloadURL + "\n" +
                   "Channel status: " + channelStatus + "\n" +
                   "Server response: " + responseStatus);
  } catch(e) {}

  subscription.lastDownload = Math.round(Date.now() / MILLISECONDS_IN_SECOND);
  subscription.downloadStatus = error;

  // Request fallback URL if necessary - for automatic updates only
  if (!manual)
  {
    if (error == "synchronize_checksum_mismatch")
    {
      // No fallback for successful download with checksum mismatch, reset error counter
      subscription.errors = 0;
    }
    else
      subscription.errors++;

    if (subscription.errors >= Prefs.subscriptions_fallbackerrors && /^https?:\/\//i.test(subscription.url))
    {
      subscription.errors = 0;

      let fallbackURL = Prefs.subscriptions_fallbackurl;
      fallbackURL = fallbackURL.replace(/%VERSION%/g, encodeURIComponent(Utils.addonVersion));
      fallbackURL = fallbackURL.replace(/%SUBSCRIPTION%/g, encodeURIComponent(subscription.url));
      fallbackURL = fallbackURL.replace(/%URL%/g, encodeURIComponent(downloadURL));
      fallbackURL = fallbackURL.replace(/%ERROR%/g, encodeURIComponent(error));
      fallbackURL = fallbackURL.replace(/%CHANNELSTATUS%/g, encodeURIComponent(channelStatus));
      fallbackURL = fallbackURL.replace(/%RESPONSESTATUS%/g, encodeURIComponent(responseStatus));

      let request = new XMLHttpRequest();
      request.mozBackgroundRequest = true;
      request.open("GET", fallbackURL);
      request.overrideMimeType("text/plain");
      request.channel.loadFlags = request.channel.loadFlags |
                                  request.channel.INHIBIT_CACHING |
                                  request.channel.VALIDATE_ALWAYS;
      request.onload = function(ev)
      {
        if (/^301\s+(\S+)/.test(request.responseText))  // Moved permanently    
          subscription.nextURL = RegExp.$1;
        else if (/^410\b/.test(request.responseText))   // Gone
        {
          subscription.autoDownload = false;
          FilterStorage.triggerSubscriptionObservers("updateinfo", [subscription]);
        }
        FilterStorage.saveToDisk();
      }
      request.send(null);
    }
  }

  FilterStorage.triggerSubscriptionObservers("updateinfo", [subscription]);
  FilterStorage.saveToDisk();
}