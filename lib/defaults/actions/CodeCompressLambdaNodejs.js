'use strict';

/**
 * Action: Code Compress: Lambda: Nodejs
 * - Compress lambda files in distribution folder
 * - Don't attach "evt" to context, it will be overwritten in concurrent operations
 */

const JawsPlugin = require('../../JawsPlugin'),
    JawsError    = require('../../jaws-error'),
    JawsUtils    = require('../../utils/index'),
    BbPromise    = require('bluebird'),
    path         = require('path'),
    fs           = require('fs'),
    os           = require('os'),
    wrench       = require('wrench'),
    Zip          = require('node-zip');

// Promisify fs module
BbPromise.promisifyAll(fs);

class CodeCompressLambdaNodejs extends JawsPlugin {

  /**
   * Constructor
   */

  constructor(Jaws, config) {
    super(Jaws, config);
  }

  /**
   * Get Name
   */

  static getName() {
    return 'jaws.core.' + CodeCompressLambdaNodejs.name;
  }

  /**
   * Register Plugin Actions
   */

  registerActions() {

    this.Jaws.addAction(this.codeCompressLambdaNodejs.bind(this), {
      handler:       'codeCompressLambdaNodejs',
      description:   'Deploys the code or endpoint of a function, or both'
    });

    return BbPromise.resolve();
  }

  /**
   * Code Compress
   */

  codeCompressLambdaNodejs(evt) {

    let _this = this;

    // Flow
    return _this._validateAndPrepare(evt)
        .bind(_this)
        .then(_this._compress)
        .then(function() {
          return evt;
        })
        .catch(function(e) {console.log(e, e.stack)})
  }

  /**
   * Validate And Prepare
   */

  _validateAndPrepare(evt) {
    let _this = this;
    return BbPromise.resolve(evt);
  }

  /**
   * Compress
   */

  _compress(evt) {

    let _this = this,
        zip = new Zip();

    evt.function.pathsPackaged.forEach(nc => {
      zip.file(nc.fileName, nc.data);
    });

    let zipBuffer = zip.generate({
      type:        'nodebuffer',
      compression: 'DEFLATE',
    });

    if (zipBuffer.length > 52428800) {
      Promise.reject(new JawsError(
          'Zip file is > the 50MB Lambda queued limit (' + zipBuffer.length + ' bytes)',
          JawsError.errorCodes.ZIP_TOO_BIG)
      );
    }

    // Set path of compressed package
    evt.function.pathCompressed = path.join(evt.function.pathDist, 'package.zip');

    // Create compressed package
    fs.writeFileSync(
        evt.function.pathCompressed,
        zipBuffer);

    JawsUtils.jawsDebug(`Compressed code written to ${evt.function.pathCompressed}`);

    return BbPromise.resolve(evt);
  }
}

module.exports = CodeCompressLambdaNodejs;