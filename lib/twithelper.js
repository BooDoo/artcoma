#!/usr/bin/env node
'use strict';

const _ = require('lodash');
const P = require('bluebird');
const Twit = require('twit');
const util = require('util');

const MAX_FILE_SIZE_BYTES = 15 * 1024 * 1024;
const MAX_FILE_CHUNK_BYTES = 5 * 1024 * 1024;
const mime = require('mime');
const fs = require('fs');
const TwitFU = require('twit/lib/file_uploader');

// Monkey-patching Twit's use of media_category to bring it up to date(?)
TwitFU.prototype._initMedia = function (cb) {
  var self = this;
  var mediaType = mime.getType(self._file_path);
  var mediaFileSizeBytes = fs.statSync(self._file_path).size;
  var shared = self._isSharedMedia;
  var media_category = 'tweet_image';

  if (mediaType.toLowerCase().indexOf('gif') > -1) {
    media_category = 'tweet_gif';
  } else if (mediaType.toLowerCase().indexOf('video') > -1) {
    media_category = 'tweet_video';
  }

  // Check the file size - it should not go over 15MB for video.
  // See https://dev.twitter.com/rest/reference/post/media/upload-chunked
  if (mediaFileSizeBytes < MAX_FILE_SIZE_BYTES) {
    self._twit.post('media/upload', {
      'command': 'INIT',
      'media_type': mediaType,
      'total_bytes': mediaFileSizeBytes,
      'shared': shared,
      'media_category': media_category
    }, cb);
  } else {
    var errMsg = util.format('This file is too large. Max size is %dB. Got: %dB.', MAX_FILE_SIZE_BYTES, mediaFileSizeBytes);
    cb(new Error(errMsg));
  }
}

let TwitHelper = function TwitHelper(config) {
  if (!(this instanceof TwitHelper)) {
    return new TwitHelper(config);
  }

  return TwitHelper.super_.call(this, config);
};

TwitHelper.prototype.postMediaChunkedAsync = P.promisify(Twit.prototype.postMediaChunked);

TwitHelper.prototype.uploadMedia = function uploadMedia(filePath) {
  return this.postMediaChunkedAsync({file_path: filePath});
};

TwitHelper.prototype.assignAltText = function assignAltText(media_id, alt_text) {
  media_id = _.isArray(media_id) ? media_id[0] : media_id;
  return this.post('media/metadata/create', {
        media_id: media_id,
        alt_text: {text: alt_text}
  });
};

TwitHelper.prototype.postTweet = function sendTweet(status, media_ids) {
  media_ids = _.isArray(media_ids) ? media_ids : [media_ids];
  return this.post('statuses/update', {
          status: status,
          media_ids: media_ids
        });
};

// Give me tweet parameters and I'll make you a Promise for a fully-featured tweet.
TwitHelper.prototype.makeTweet = async function tweetWithMediaAndMetadata(status, mediaPath, altText) {
  let uploadResponse, mediaIdStr, metadataResponse, metadataStatus, tweetResponse;

  uploadResponse = mediaPath ? await this.uploadMedia(mediaPath) : null;
  mediaIdStr = uploadResponse ? uploadResponse.media_id_string : null;
  metadataResponse = altText && mediaIdStr ? await this.assignAltText(mediaIdStr, altText) : null;

  return tweetResponse = this.postTweet(status, mediaIdStr);
};

util.inherits(TwitHelper, Twit);

module.exports = exports = TwitHelper;
