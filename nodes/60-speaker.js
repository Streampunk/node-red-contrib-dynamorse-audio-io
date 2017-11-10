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

const redioactive = require('node-red-contrib-dynamorse-core').Redioactive;
const util = require('util');
const naudiodon = require('naudiodon');
const Grain = require('node-red-contrib-dynamorse-core').Grain;
const uuid = require('uuid');

module.exports = function (RED) {
  function Speaker (config) {
    RED.nodes.createNode(this, config);
    redioactive.Spout.call(this, config);

    let srcTags = null;
    let srcFlowID = null;
    let bitsPerSample = 16;
    let audioOutput = null;
    let audioStarted = false;
    let node = this;

    this.each((x, next) => {
      if (!Grain.isGrain(x)) {
        node.warn('Received non-Grain payload.');
        return next();
      }

      let nextJob = (srcTags) ?
        Promise.resolve(x) :
        this.findCable(x).then(f => {
          if (!Array.isArray(f[0].audio) && f[0].audio.length < 1) {
            return Promise.reject('Logical cable does not contain audio.');
          }
          srcTags = f[0].audio[0].tags;
          srcFlowID = f[0].audio[0].flowID;

          var audioOptions = {};
          bitsPerSample = +srcTags.encodingName.substring(1);
          switch (bitsPerSample) {
          case 8:
            audioOptions.sampleFormat = naudiodon.SampleFormat8Bit;
            break;
          case 16:
            audioOptions.sampleFormat = naudiodon.SampleFormat16Bit;
            break;
          case 24:
            audioOptions.sampleFormat = naudiodon.SampleFormat24Bit;
            break;
          case 32:
            audioOptions.sampleFormat = naudiodon.SampleFormat32Bit;
            break;
          default:
            throw new Error('Cannot determine sample format bits per sample.');
          }
          audioOptions.channelCount = srcTags.channels;
          audioOptions.sampleRate = srcTags.clockRate;
          if (config.deviceIndex >= 0) {
            audioOptions.deviceId= config.deviceIndex;
          }
          console.log(audioOptions);
          audioOutput = new naudiodon.AudioWriter(audioOptions);
          return new Promise((accept, reject) => {
            var happyCallback = () => {
              audioOutput.removeListener('error', reject);
              audioOutput.on('error', err => {
                node.error(`Error received from port audio library: ${err}`);
              });
              accept(x);
            };
            audioOutput.once('error', err => {
              audioOutput.removeListener('audio_ready', happyCallback);
              reject(err);
            });
            audioOutput.once('audio_ready', happyCallback);
          });
        });

      nextJob.then(g => {
        if (uuid.unparse(g.flow_id) !== srcFlowID)
          return next();

        var capacity = audioOutput.write(swapBytes(g, bitsPerSample));
        if (audioStarted === false) {
          audioOutput.pa.start();
          audioStarted = true;
        }
        if (capacity === true) {
          next();
        }
        else {
          audioOutput.once('drain', next);
        }
      }).catch(err => {
        node.error(`Failed to play sound on device '${config.deviceIndex}': ${err}`);
      });
    }); // this.each
    this.errors((e, next) => {
      node.warn(`Received unhandled error: ${e.message}.`);
      setImmediate(next);
    });
    this.done(() => {
      node.log('No more to hear here!');
      audioOutput.end();
    });
    this.on('close', () => {
      node.log('Closing the speaker - too loud!');
      audioOutput.end();
      this.close();
    });
  }
  util.inherits(Speaker, redioactive.Spout);
  RED.nodes.registerType('speaker', Speaker);

  function swapBytes(x, bitsPerSample) {
    x.buffers.forEach(x => {
      let tmp = 0|0;
      switch (bitsPerSample) {
      case 24:
        tmp = 0|0;
        for ( let y = 0|0 ; y < x.length ; y += 3|0 ) {
          tmp = x[y];
          x[y] = x[y + 2];
          x[y + 2] = tmp;
        }
        break;
      case 16:
        tmp = 0|0;
        for ( let y = 0|0 ; y < x.length ; y += 2|0 ) {
          tmp = x[y];
          x[y] = x[y + 1];
          x[y + 1] = tmp;
        }
        break;
      default: // No swap
        break;
      }
    });
    return x.buffers[0];
  }
};
