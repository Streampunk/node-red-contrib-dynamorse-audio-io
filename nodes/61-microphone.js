/* Copyright 2017 Streampunk Media Ltd.

  Licensed under the Apache License, Version 2.0 (the "License");
  you may not use this file except in compliance with the License.
  You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

  Unless required by applicable law or agreed to in writing, software
  distributed under the License is distributed on an "AS IS" BASIS,
  WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
  See the License for the specific language governing permissions and
  limitations under the License.
*/

var redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
var util = require('util');
var naudiodon = require('naudiodon');
var Promise = require('promise');
var Grain = require('node-red-contrib-dynamorse-core').Grain;
var ledger = require('nmos-ledger');
var H = require('highland');

function swapBytes(x, bitsPerSample) {
  switch (bitsPerSample) {
    case 24:
      var tmp = 0|0;
      for ( var y = 0|0 ; y < x.length ; y += 3|0 ) {
        tmp = x[y];
        x[y] = x[y + 2];
        x[y + 2] = tmp;
      }
      break;
    case 16:
      var tmp = 0|0;
      for ( var y = 0|0 ; y < x.length ; y += 2|0 ) {
        tmp = x[y];
        x[y] = x[y + 1];
        x[y + 1] = tmp;
      }
      break;
    default: // No swap
      break;
  }
  return x;
}

function chunker (pattern, blockAlign, bitsPerSample) {
  var grainCount = 0;
  var leftOver = null;
  var chunky = b => {
    var position = 0;
    var gs = [];
    var gl = pattern[grainCount % pattern.length] * blockAlign;
    if (leftOver) {
      gs.push(swapBytes(Buffer.concat([leftOver, b.slice(0, gl - leftOver.length)]), bitsPerSample));
      position += gs[0].length;
      gl = pattern[++grainCount % pattern.length] * blockAlign;
    }
    while (b.length - position > gl) {
      gs.push(swapBytes(b.slice(position, position + gl), bitsPerSample));
      position += gl;
      gl = pattern[++grainCount % pattern.length] * blockAlign;
    }
    if (b.length - position > 0) {
      leftOver = b.slice(position)
    } else {
      leftOver = null;
    }
    return H(gs);
  };
  return H.flatMap(chunky);
}

module.exports = function (RED) {
  function Microphone (config) {
    RED.nodes.createNode(this, config);
    redioactive.Funnel.call(this, config);

    this.bitsPerSample = +config.encodingName.slice(1);
    this.channels = config.channels;
    this.blockAlign = (this.bitsPerSample * this.channels + 7) / 8 | 0;
    this.sampleRate = config.sampleRate;
    this.pattern = [ '1920' ];

    this.sampleFormat = naudiodon.SampleFormat16Bit;
    switch (this.bitsPerSample) {
      case 8: this.sampleFormat = naudiodon.SampleFormat8Bit; break;
      case 24: this.sampleFormat = naudiodon.SampleFormat16Bit; break;
      case 32: this.sampleFormat = naudiodon.SampleForamt32Bit; break;
      default: break;
    }

    this.baseTime = [ Date.now() / 1000|0, (Date.now() % 1000) * 1000000 ];

    var audioOptions = {
      channelCount: this.channels,
      sampleFormat: this.sampleFormat,
      sampleRate: this.sampleRate
    };
    if (config.deviceIndex >= 0) {
      audioOptions.deviceId = config.deviceIndex;
    }
    var audioInput = new naudiodon.AudioReader(audioOptions);
    var nodeAPI = this.context().global.get('nodeAPI');
    var ledger = this.context().global.get('ledger');
    var localName = config.name || `${config.type}-${config.id}`;
    var localDescription = config.description || `${config.type}-${config.id}`;
    var pipelinesID = config.device ?
      RED.nodes.getNode(config.device).nmos_id :
      this.context().global.get('pipelinesID');
    var source = new ledger.Source(null, null, localName, localDescription,
      "urn:x-nmos:format:audio", null, null, pipelinesID, null);
    var flow = new ledger.Flow(null, null, localName, localDescription,
      "urn:x-nmos:format:audio", this.tags, source.id, null);
    audioInput.once('audio_ready', pa => {
      this.log('Audio is ready!!!!');
      nodeAPI.putResource(source)
      .then(() => nodeAPI.putResource(flow))
      .then(() => {
        this.log('Creating highland stream to pipe in audio input.');
        this.highland(
          H(audioInput)
          .through(chunker(this.pattern, this.blockAlign, this.bitsPerSample))
          .map(b => {
            var grainTime = Buffer.allocUnsafe(10);
            grainTime.writeUIntBE(this.baseTime[0], 0, 6);
            grainTime.writeUInt32BE(this.baseTime[1], 6);
            var grainDuration = [ b.length / this.blockAlign|0, this.sampleRate ];
            this.baseTime[1] = ( this.baseTime[1] +
              grainDuration[0] * 1000000000 / grainDuration[1]|0 );
            this.baseTime = [ this.baseTime[0] + this.baseTime[1] / 1000000000|0,
              this.baseTime[1] % 1000000000];
            return new Grain([b], grainTime, grainTime, null,
              flow.id, source.id, grainDuration);
          })
        );
        this.log('Starting stream.');
        audioInput.pa.start();
      });
    });

    this.close(() => {
      node.log('Closing the microphone - I\'ve heard enough!');
      audioInput.end();
      audioInput.pa.stop();
    });
  }
  util.inherits(Microphone, redioactive.Funnel);
  RED.nodes.registerType("microphone", Microphone);
}
