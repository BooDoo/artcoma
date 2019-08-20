#!/usr/bin/env node
'use strict';

// Replace Math.random() with MT-based substitute:
Math.random = require('./lib/mt-rng');

// General requirements
const _ = require('lodash');
const P = require('bluebird');
const os = require('os');
const path = require('path');
const qs = require('querystring');
const cheerio = require('cheerio');
// Promisfy some imports for convenience sake
const fs = P.promisifyAll(require('fs'));
const rp = require('request-promise');
const exec = require('child-process-promise').exec;
// Read API keys etc
const creds = require('./credentials');
// Twitter interface
const Twit = require('./lib/twithelper');
const T = new Twit(creds.live);
// Masto interface
const Mastodon = require('mastodon-api');
const M = new Mastodon(creds.live.masto);

const TMP_OUT = path.join(os.tmpdir(), 'artcoma.jpg');
const TMP_IN = path.join(os.tmpdir(), 'artpiece.jpg');

// Interpret a year as a year, or assume anything with letters is a century:
function parseStartDate(d) {
    return d.match(/\D/) ? _.parseInt(d.replace(/\D/g,'')) * 100 : _.parseInt(d);
}
function parseEndDate(d) {
    return d.match(/\D/) ? _.parseInt(d.replace(/\D/g,'')) * 100 - 99 : _.parseInt(d);
}

// this function is hell on earth, never unfold it
function parseDate(date) {
  if (_.isUndefined(date) || _.isNull(date)) {
    return date;
  }

  const rangeIndicators = /\ ?[\-\–\—]\ ?|\ or\ |\ to\ /gi;
  let start, end;
  date = date.split(',')[0]; // do not fuck with commas
  if (date.match(rangeIndicators)) {
    [start, end] = date.split(rangeIndicators);
    if (end.match(/b\.c\./gi)) {
      if (date.match(/centur/gi)) {
        start = parseStartDate(start) * -1;
        end = parseEndDate(end) * -1;
      } else {
        start = _.parseInt(start.replace(/\D/g, '')) * -1;
        end = _.parseInt(end.replace(/\D/g, '')) * -1;
      }
    }
    else {
      if (start.match(/b\.c\./gi) ) {
        start = _.parseInt(start.replace(/\D/g, '')) * -1;
      } else {
        start = _.parseInt(start.replace(/\D/g, ''));
      }
      end = _.parseInt(end.replace(/\D/g, ''));
      if (end < start) {
        let [startString,endString] = [start,end].map(_.method('toString'));
        let lenDiff = startString.length - endString.length;
        end = _.parseInt(_.take(startString,lenDiff).concat(endString.split('')).join(''));
      }
    }
  }
  else if (date.match(/centur/gi)) {
    if (date.match(/b\.c\./gi)) {
      start = parseStartDate(date) * -1;
      end = start + 99;
    } else {
      start = parseStartDate(date) - 100;
      end = start + 99;
    }
  }
  else {
    end = start = _.parseInt(date.replace(/\D/g, ''));
  }
  return {start: start, end: end};
}

// this one isn't great either...
function dateStringFromRange(range) {
  if (_.isNull(range) || _.isUndefined(range)) {
    return range;
  }

  let [start, end] = [range.start, range.end];
  let dateString;

  if (start == end) {
    if (start < 0) {
      dateString = `${start * -1} B.C.`;
    } else {
      dateString = `A.D. ${start}`;
    }
  }
  else {
    if (start < 0 && end < 0) {
      dateString = `${start * -1}–${end * -1} B.C.`;
    }
    else if (start < 0) {
      dateString = `${start * -1} B.C.–A.D. ${end}`;
    }
    else {
      dateString = `A.D. ${start}–${end}`;
    }
  }
  return dateString;
}

// const TARGET_ERA = _.sample(['1000+B.C.-A.D.+1','2000-1000+B.C.']);
// const MATERIAL = _.sample(["Ceramics"]);
const PER_PAGE = 12;
const MAX_PAGE = 80; // rough limiter for all CERAMIC objects on display
// const ENDPOINT = `https://www.mfa.org/collections/search?f[0]=field_onview%3A1&f[1]=field_checkbox%3A1&page=${_.random(MAX_PAGE)}`;
const BASE_URL = `https://collections.mfa.org`;
const ENDPOINT = `${BASE_URL}/search/Objects/classifications%3ACeramics%3Bonview%3Atrue%3BimageExistence%3Atrue/*/images?page=${_.random(MAX_PAGE)}`;

// If/when we want to be more specific about page limit:
async function getMaxPageNumber(endpoint) {
  return _.floor(getTotal(endpoint) / PER_PAGE);
}

async function getTotal(endpoint) {
  let resBody = await rp(endpoint, {
      headers: {'User-Agent': 'Etruscan Ceramic / Twitter bot / ART PROJECT'}
    });
  return _.parseInt(cheerio.load(res)('div.current-search-item-text').text().replace(/\D/g,''));
}

function parsePieceSummary(gridItem) {
    let pieceObj = {};

    pieceObj.artist = cheerio(gridItem).find('.primaryMaker').text().trim();
    pieceObj.img = BASE_URL + cheerio(gridItem).find('img').get(0).attribs.src;
    pieceObj.href = BASE_URL + cheerio(gridItem).find('a').get(0).attribs.href;
    pieceObj.date = cheerio(gridItem).find('.displayDate').text().trim().replace(/Date:\s*/,'');

    pieceObj.dateRange = parseDate(pieceObj.date);
    pieceObj.dateString = dateStringFromRange(pieceObj.dateRange);

    // No title or no date? No return.
    if (pieceObj.title && pieceObj.date) {
      return null;
    }
    return pieceObj;
}

function filterByText(context, el, regex) {
    return context(el).text().match(regex);
}

async function getPieceDetails(piece) {
  let pieceDetails = {};
  let res = await rp(piece.href, {
      headers: {'User-Agent': 'Etruscan Ceramic / Twitter bot / ART PROJECT'}
    });
  let $ = cheerio.load(res);
  
  pieceDetails.title = $('.titleField > h2').text().trim();
  pieceDetails.date = $('.displayDateField').text().trim();
  pieceDetails.culture = $('.cultureField').text().trim();
  // if (pieceDetails.culture.match(/\d\d+/)) { pieceDetails.culture=''; }
  pieceDetails.medium = $('.mediumField > .detailFieldValue').text().trim();
  pieceDetails.gallery = $('.onviewField > .locationLink').text().trim();
  return pieceDetails;
}

async function saveBinary(uri, destination) {
  let res = await rp({url: uri,
      headers: {'User-Agent': 'Etruscan Ceramic / Twitter bot / ART PROJECT'}
    , encoding: 'binary'});
  let written = await fs.writeFileAsync(destination, res, 'binary');
  return res;
}

async function makeToot(status, mediaPath=null, altText="", client) {
  let uploadParams = {}, uploadResponse, mediaIdStr, postParams={}, tootResponse;
  if (!_.isEmpty(mediaPath)) {
    uploadParams.file = fs.createReadStream(mediaPath);
    if (!_.isEmpty(altText)) { uploadParams.description = altText; }
    uploadResponse = await client.post('media', uploadParams);
  }
  mediaIdStr = uploadResponse ? uploadResponse.data.id : null;

  postParams.status = status;
  postParams.media_ids = [mediaIdStr];

  return tootResponse = client.post('statuses', postParams);
}

async function main(endpoint) {
  // console.log(`hitting ${endpoint}...`);
  let res = await rp(endpoint, {
      headers: {'User-Agent': 'Etruscan Ceramic / Twitter bot / ART PROJECT'}
    });
  let $ = cheerio.load(res);
  let objects = $('.result.item');
  let pieces = _.map(objects, parsePieceSummary);
  // Filter pieces here? For range of dates/specific wordcount/etc?
  let piece = _.sample(pieces);
  let pieceDetails = await getPieceDetails(piece);
  piece = Object.assign(piece, pieceDetails); // {title, date, href, img, dateRange, dateString, culture, medium, gallery}
  console.dir(piece);
  // return piece;
  let imgBody = await saveBinary(piece.img, TMP_IN)
  // Strings for image generation:
  let thisYear = new Date().getFullYear();
  let comaLength;
  if (piece.dateRange.start == piece.dateRange.end) {
    comaLength = `${thisYear - piece.dateRange.start} years`;
  } else {
    comaLength = `${thisYear - piece.dateRange.end}-${thisYear - piece.dateRange.start} years`;
  }
  let pieceLabel = `${piece.title} ${piece.dateString} ${piece.culture} ${piece.medium}`;
  let reply = `you're in luck because ${pieceLabel} can be found in the Boston Museum of Fine Arts' ${piece.gallery}`;
  // Now let's make that image:
  let magickBin = process.env.IMAGEMAGICK_BINARY || 'convert';
  let magickArgs = `./assets/base.png -gravity Northwest -pointsize 64 -annotate +25+55 "${comaLength}" -pointsize 40 -size 925x200 -background none caption:"${pieceLabel}" -trim -geometry +142+218 -composite -pointsize 40 -size 670x200 -background none caption:"${pieceLabel}" -trim -geometry +5+972 -composite -draw "image over 0,1110 685,600 '${TMP_IN}'" -pointsize 24 -size 760x140 caption:"${reply}" -trim -geometry +316+835 -composite ${TMP_OUT}`;
  let imCall = `"${magickBin}" ${magickArgs}`;
  let callRes = await exec(imCall);
  // console.log(imCall);
  let status = pieceLabel;
  let altText = reply;

  let mastoRes = await makeToot(status, TMP_OUT, altText, M);
  return T.makeTweet(status, TMP_OUT, altText);
}

main(ENDPOINT).then(res=>console.log(`ARTCOMA twote: ${res.data.id_str}`)).catch(console.error);
