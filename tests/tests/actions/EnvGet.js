'use strict';

/**
 * Test: Env Get Action
 */

let JAWS      = require('../../../lib/Jaws.js'),
    path      = require('path'),
    utils     = require('../../../lib/utils/index'),
    assert    = require('chai').assert,
    testUtils = require('../../test_utils'),
    config    = require('../../config');

let Jaws;

describe('Test Action: Env Get', function() {

  before(function(done) {
    this.timeout(0);

    testUtils.createTestProject(config)
        .then(projPath => {
          process.chdir(projPath);
          Jaws = new JAWS({
            interactive: false,
            awsAdminKeyId:     config.awsAdminKeyId,
            awsAdminSecretKey: config.awsAdminSecretKey
          });

          done();
        });
  });

  after(function(done) {
    done();
  });

  describe('Env Get', function() {
    it('Should Get Env Var', function(done) {

      this.timeout(0);

      let event = {
        stage:      config.stage,
        region:     config.region,
        key:    'JAWS_STAGE',
      };

      Jaws.actions.envGet(event)
          .then(function() {
            done();
          })
          .catch(e => {
            done(e);
          });
    });
  });

});