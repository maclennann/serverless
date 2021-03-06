'use strict';

/**
 * Action: Endpoint Build ApiGateway
 * - Creates API Gateway endpoints on the AWS account.
 * - Handles one endpoint only in one region.  The FunctionDeploy Action orchestrates this.
 */

const SPlugin       = require('../ServerlessPlugin'),
    SError          = require('../ServerlessError'),
    SUtils          = require('../utils/index'),
    BbPromise       = require('bluebird'),
    path            = require('path'),
    fs              = require('fs'),
    os              = require('os');

// Promisify fs module.
BbPromise.promisifyAll(fs);

class EndpointBuildApiGateway extends SPlugin {

  /**
   * Constructor
   */

  constructor(S, config) {
    super(S, config);
  }

  /**
   * Get Name
   */

  static getName() {
    return 'serverless.core.' + EndpointBuildApiGateway.name;
  }

  /**
   * Register Actions
   */

  registerActions() {
    this.S.addAction(this.endpointBuildApiGateway.bind(this), {
      handler:     'endpointBuildApiGateway',
      description: 'Provision one or multiple endpoints on API Gateway',
    });
    return BbPromise.resolve();
  }

  /**
   * Endpoint Build ApiGateway
   */

  endpointBuildApiGateway(evt) {
    let builder = new Builder(this.S);
    return builder.build(evt);
  }
}

/**
 * Builder
 * - Necessary for this action to run concurrently
 */

class Builder {

  constructor(S) {
    this.S = S;
  }

  build(evt) {

    let _this = this;

    return _this._validateAndPrepare(evt)
        .bind(_this)
        .then(_this._fetchDeployedLambda)
        .then(_this._getApiResources)
        .then(_this._createEndpointResources)
        .then(_this._createEndpointMethod)
        .then(_this._createEndpointIntegration)
        .then(_this._createEndpointMethodResponses)
        .then(_this._createEndpointMethodIntegResponses)
        .then(_this._manageLambdaAccessPolicy)
        .then(function() {

          evt.endpoint.url = 'https://'
              + evt.region.restApiId
              + '.execute-api.'
              +  evt.region.region
              + '.amazonaws.com/'
              + evt.stage
              + '/'
              + evt.endpoint.path;

          SUtils.sDebug(
              '"'
              + evt.stage
              + '" successfully deployed endpoint to API Gateway in the region "'
              + evt.region.region
              + '". Access it via '
              + evt.endpoint.method
              + ' @ '
              + evt.endpoint.url);

          return evt;
        });
  }

  /**
   * Validate And Prepare
   */

  _validateAndPrepare(evt) {

    let _this = this;

    // Get AWS Account Number
    evt.awsAccountNumber = evt.region.iamRoleArnLambda.replace('arn:aws:iam::', '').split(':')[0];

    // Load AWS Service Instances
    let awsConfig = {
      region:          evt.region.region,
      accessKeyId:     _this.S._awsAdminKeyId,
      secretAccessKey: _this.S._awsAdminSecretKey,
    };

    _this.CloudFormation = require('../utils/aws/CloudFormation')(awsConfig);
    _this.ApiGateway     = require('../utils/aws/ApiGateway')(awsConfig);
    _this.Lambda         = require('../utils/aws/Lambda')(awsConfig);

    // Validate and sanitize endpoint attributes
    if (!evt.endpoint.path) {
      throw new SError('Endpoint does not have a "path" property');
    }
    if (!evt.endpoint.method) {
      throw new SError('Endpoint does not have a "method" property');
    }
    if (!evt.endpoint.authorizationType) {
      throw new SError('Endpoint does not have a "authorizationType" property');
    }
    if (typeof evt.endpoint.apiKeyRequired === 'undefined') {
      throw new SError('Endpoint does not have a "apiKeyRequired" property');
    }
    if (!evt.endpoint.requestTemplates) {
      throw new SError('Endpoint does not have a "requestTemplates" property');
    }
    if (!evt.endpoint.requestParameters) {
      throw new SError('Endpoint does not have a "requestParameters" property');
    }
    if (!evt.endpoint.responses) {
      throw new SError('Endpoint does not have a "responses" property');
    }

    // Sanitize path
    if (evt.endpoint.path.charAt(0) === '/') evt.endpoint.path = evt.endpoint.path.substring(1);

    // Sanitize method
    evt.endpoint.method = evt.endpoint.method.toUpperCase();

    // Prepare StatementId
    evt.endpoint.statementId = ('s-apig-' + evt.endpoint.path + '-' + evt.endpoint.method).replace(/\//g, '_');

    return BbPromise.resolve(evt);
  }

  /**
   * Fetch Deployed Lambda
   * @private
   */

  _fetchDeployedLambda(evt) {

    let _this = this;
    let params = {
      FunctionName: _this.Lambda.sGetLambdaName(_this.S._projectJson, evt.endpoint.function), /* required */
      Qualifier:    evt.stage
    };

    return _this.Lambda.getFunctionPromised(params)
        .then(function(data) {
          evt.endpoint.lambda = data.Configuration;
          return evt;
        });
  }

  /**
   * Get API Resources
   * @returns {Promise}
   * @private
   */

  _getApiResources(evt) {

    let _this = this;

    let params = {
      restApiId: evt.region.restApiId, /* required */
      limit: 500
    };

    // List all Resources for this REST API
    return _this.ApiGateway.getResourcesPromised(params)
        .then(function(response) {

          evt.apiResources = response.items;

          // Get Parent Resource ID
          for (let i = 0; i < evt.apiResources.length; i++) {
            if (evt.apiResources[i].path === '/') {
              evt.apiParentResourceId = evt.apiResources[i].id;
            }
          }

          SUtils.sDebug(
              '"'
              + evt.stage + ' - '
              + evt.region.region
              + '": found '
              + evt.apiResources.length
              + ' existing Resources on API Gateway');

          return evt;
        });
  }

  /**
   * Create Endpoint Resources
   * @returns {Promise}
   * @private
   */

  _createEndpointResources(evt) {

    let _this      = this,
        endpoint   = evt.endpoint,
        eResources = endpoint.path.split('/');

    /**
     * Private Function to find resource
     * @param resource
     * @param parent
     * @returns {*}
     */

    let findEndpointResource = function(resource, parent) {

      // Replace slashes in resource
      resource  = resource.replace(/\//g, '');
      let index = eResources.indexOf(resource),
          resourcePath,
          resourceIndex;

      if (parent) {
        index    = index - 1;
        resource = eResources[index];
      }

      if (index < 0) {
        resourcePath = '/';
      } else {
        resourceIndex = endpoint.path.indexOf(resource);
        resourcePath  = '/' + endpoint.path.substring(0, resourceIndex + resource.length);
      }

      // If resource has already been created, skip it
      for (let i = 0; i < evt.apiResources.length; i++) {

        // Check if path matches, in case there are duplicate resources (users/list, org/list)
        if (evt.apiResources[i].path === resourcePath) {
          return evt.apiResources[i];
        }
      }
    };

    return BbPromise.try(function() {

      return eResources;

    }).each(function(eResource) {

      // Remove slashes in resource
      eResource = eResource.replace(/\//g, '');

      // If resource exists, skip it
      let resource = findEndpointResource(eResource);
      if (resource) return resource;

      // Get Parent Resource
      evt.apiParentResourceId = findEndpointResource(eResource, true).id;

      let params = {
        parentId:  evt.apiParentResourceId, /* required */
        pathPart:  eResource, /* required */
        restApiId: evt.region.restApiId /* required */
      };

      // Create Resource
      return _this.ApiGateway.createResourcePromised(params)
          .then(function(response) {

            // Add resource to _this.resources and callback
            evt.apiResources.push(response);

            SUtils.sDebug(
                '"'
                + evt.stage + ' - '
                + evt.region.region
                + ' - ' + evt.endpoint.path + '": '
                + 'created resource: '
                + response.pathPart);
          });

    }).then(function() {

      // Attach the last resource to endpoint for later use
      let endpointResource = endpoint.path.split('/').pop().replace(/\//g, '');
      evt.resource         = findEndpointResource(endpointResource);

      return evt;
    });
  }

  /**
   * Create Endpoint Method
   * @returns {Promise}
   * @private
   */

  _createEndpointMethod(evt) {

    let _this      = this,
        endpoint   = evt.endpoint,
        requestParameters = {};

    // If Request Params, add them
    if (endpoint.RequestParameters) {

      // Format them per APIG API's Expectations
      for (let prop in endpoint.requestParameters) {
        let requestParam                = endpoint.requestParameters[prop];
        requestParameters[requestParam] = true;
      }
    }

    let params = {
      httpMethod: endpoint.method, /* required */
      resourceId: evt.resource.id, /* required */
      restApiId:  evt.region.restApiId /* required */
    };

    return _this.ApiGateway.getMethodPromised(params)
        .then(function(response) {

          // Method exists.  Delete and recreate it.

          // First, save integration's Lambda aliasEndpoint, if any
          if (response.methodIntegration) {
            evt.prevIntegration = response.methodIntegration;
          }

          let params = {
            httpMethod: endpoint.method, /* required */
            resourceId: evt.resource.id, /* required */
            restApiId:  evt.region.restApiId /* required */
          };

          return _this.ApiGateway.deleteMethodPromised(params)
              .then(function() {

                let params = {
                  authorizationType:  endpoint.authorizationType, /* required */
                  httpMethod:         endpoint.method, /* required */
                  resourceId:         evt.resource.id, /* required */
                  restApiId:          evt.region.restApiId, /* required */
                  apiKeyRequired:     endpoint.apiKeyRequired,
                  requestModels:      endpoint.requestModels,
                  requestParameters:  requestParameters
                };

                return _this.ApiGateway.putMethodPromised(params);
              });
        }, function(error) {

          // Method does not exist.  Create it.

          let params = {
            authorizationType:  endpoint.authorizationType, /* required */
            httpMethod:         endpoint.method, /* required */
            resourceId:         evt.resource.id, /* required */
            restApiId:          evt.region.restApiId, /* required */
            apiKeyRequired:     endpoint.apiKeyRequired,
            requestModels:      endpoint.requestModels,
            requestParameters:  requestParameters
          };

          return _this.ApiGateway.putMethodPromised(params);
        })
        .delay(250) // API Gateway takes time to delete Methods.  Might have to increase this.
        .then(function(response) {

          SUtils.sDebug(
              '"'
              + evt.stage + ' - '
              + evt.region.region
              + ' - ' + evt.endpoint.path + '": '
              + 'created method: '
              + endpoint.method);

          return evt;
        });
  }

  /**
   * Create Endpoint Integration
   */

  _createEndpointIntegration(evt) {

    let _this           = this,
        endpoint        = evt.endpoint;

    // Alias Lambda, default ot $LATEST
    let alias;
    if (evt.aliasEndpoint) alias  = evt.aliasEndpoint;
    else alias = '${stageVariables.functionAlias}';

    let params = {
      httpMethod:             endpoint.method, /* required */
      resourceId:             evt.resource.id, /* required */
      restApiId:              evt.region.restApiId, /* required */
      type:                   'AWS', /* required */
      cacheKeyParameters:     endpoint.cacheKeyParameters || [],
      cacheNamespace:         endpoint.cacheNamespace     || null,
      // Due to a bug in API Gateway reported here: https://github.com/awslabs/aws-apigateway-swagger-importer/issues/41
      // Specifying credentials within API Gateway causes extra latency (~500ms)
      // Until API Gateway is fixed, we need to make a separate call to Lambda to add credentials to API Gateway
      // Once API Gateway is fixed, we can use this in credentials:
      // _this._regionJson.iamRoleArnApiGateway
      credentials:            null,
      integrationHttpMethod:  'POST',
      requestParameters:      endpoint.requestParameters || {},
      requestTemplates:       endpoint.requestTemplates  || {},
      uri:                    'arn:aws:apigateway:' // Make ARN for apigateway - lambda
                              + evt.region.region
                              + ':lambda:path/2015-03-31/functions/arn:aws:lambda:'
                              + evt.region.region
                              + ':'
                              + evt.awsAccountNumber
                              + ':function:'
                              + evt.endpoint.lambda.FunctionName
                              + ':'
                              + alias
                              + '/invocations'
    };

    // Create Integration
    return _this.ApiGateway.putIntegrationPromised(params)
        .then(function(response) {

          // Save integration
          evt.integration = response;

          SUtils.sDebug(
              '"'
              + evt.stage + ' - '
              + evt.region.region
              + ' - ' + evt.endpoint.path + '": '
              + 'created integration with the type: AWS');

          return evt;
        })
        .catch(function(error) {
          throw new SError(
              error.message,
              SError.errorCodes.UNKNOWN);
        });
  }

  /**
   * Create Endpoint Method Response
   */

  _createEndpointMethodResponses(evt) {

    let _this           = this,
        endpoint        = evt.endpoint;

    return BbPromise.try(function() {

          // Collect Response Keys
          if (endpoint.responses) return Object.keys(endpoint.responses);
          else return [];

        })
        .each(function(responseKey) {

          // Iterate through each response to be created

          let thisResponse       = endpoint.responses[responseKey];
          let responseParameters = {};
          let responseModels     = {};

          // If Response Params, add them
          if (thisResponse.responseParameters) {
            // Format Response Parameters per APIG API's Expectations
            for (let prop in thisResponse.responseParameters) {
              responseParameters[prop] = true;
            }
          }

          // If Request models, add them
          if (thisResponse.responseModels) {
            // Format Response Models per APIG API's Expectations
            for (let name in thisResponse.responseModels) {
              let value            = thisResponse.responseModels[name];
              responseModels[name] = value;
            }
          }

          let params = {
            httpMethod:         endpoint.method, /* required */
            resourceId:         evt.resource.id, /* required */
            restApiId:          evt.region.restApiId, /* required */
            statusCode:         thisResponse.statusCode, /* required */
            responseModels:     responseModels,
            responseParameters: responseParameters
          };

          // Create Method Response
          return _this.ApiGateway.putMethodResponsePromised(params)
              .then(function() {

                SUtils.sDebug(
                    '"'
                    + evt.stage + ' - '
                    + evt.region.region
                    + ' - ' + evt.endpoint.path + '": '
                    + 'created method response');

              })
              .catch(function(error) {
                throw new SError(error.message);
              });
        })
        .then(function() {
          return evt;
        });
  }

  /**
   * Create Method Integration Response
   */

  _createEndpointMethodIntegResponses(evt) {

    let _this           = this,
        endpoint        = evt.endpoint;

    return BbPromise.try(function() {

          // Collect Response Keys
          if (endpoint.responses) return Object.keys(endpoint.responses);
          else return [];
        })
        .each(function(responseKey) {

          let thisResponse       = endpoint.responses[responseKey];

          // Add Response Parameters
          let responseParameters = thisResponse.responseParameters || {};

          // Add Response Templates
          let responseTemplates = thisResponse.responseTemplates || {};

          // Add SelectionPattern
          let selectionPattern = thisResponse.selectionPattern || (responseKey === 'default' ? null : responseKey);

          let params = {
            httpMethod:         endpoint.method, /* required */
            resourceId:         evt.resource.id, /* required */
            restApiId:          evt.region.restApiId, /* required */
            statusCode:         thisResponse.statusCode, /* required */
            responseParameters: responseParameters,
            responseTemplates:  responseTemplates,
            selectionPattern:   selectionPattern,
          };

          // Create Integration Response
          return _this.ApiGateway.putIntegrationResponsePromised(params)
              .then(function() {

                SUtils.sDebug(
                    '"'
                    + evt.stage + ' - '
                    + evt.region.region
                    + ' - ' + evt.endpoint.path + '": '
                    + 'created method integration response');

              }).catch(function(error) {
                throw new SError(error.message);
              });
        })
        .then(function() {
          return evt;
        });
  }

  /**
   * Manage Lambda Access Policy
   */

  _manageLambdaAccessPolicy(evt) {

    let _this = this;

    // If method integration is not for a lambda, skip
    if (!evt.endpoint.lambda) return Promise.resolve();

    return _this._getLambdaAccessPolicy(evt)
        .bind(_this)
        .then(_this._removeLambdaPermissionForEndpoint)
        .then(_this._addLambdaPermissionForEndpoint);
  }

  /**
   * Get Lambda Access Policy
   * - Since specifying credentials when creating the Method Integration results in ~500ms
   * - of extra latency, this function updates the lambda's access policy instead
   * - to grant API Gateway permission.  This is how the API Gateway console does it.
   * - But this is not finished and the "getPolicy" method in the SDK is broken, so this
   * - is currently impossible to implement.
   */

  _getLambdaAccessPolicy(evt) {

    let _this  = this;

    let params = {
      FunctionName: evt.endpoint.lambda.FunctionArn, /* required */
      //Qualifier: 'STRING_VALUE'
    };

    return _this.Lambda.getPolicyPromised(params)
        .then(function(data) {
          evt.endpoint.lambdaPolicy = JSON.parse(data.Policy);
          return evt;
        })
        .catch(function(e) {
          return evt;
        });
  }

  /**
   * Remove Lambda Access Policy
   */

  _removeLambdaPermissionForEndpoint(evt) {

    let _this       = this,
        statement;

    if (evt.endpoint.lambdaPolicy) {
      let policy = evt.endpoint.lambdaPolicy;
      for (let i = 0; i < policy.Statement.length; i++) {
        statement = policy.Statement[i];
        if (statement.Sid && statement.Sid === evt.endpoint.statementId) continue;
      }
    }

    if (!statement) return BbPromise.resolve(evt);

    let params = {
      FunctionName: evt.endpoint.lambda.FunctionArn, /* required */
      StatementId:  evt.endpoint.statementId, /* required */
      //Qualifier: 'STRING_VALUE'
    };

    return _this.Lambda.removePermissionPromised(params)
        .then(function(data) {

          SUtils.sDebug(
              '"'
              + evt.stage + ' - '
              + evt.region.region
              + ' - ' + evt.endpoint.path + '": '
              + 'removed existing lambda access policy statement');

          return evt;
        })
        .catch(function(error) {
          return evt;
        });
  }

  /**
   * Add Lambda Permission For Endpoint
   */

  _addLambdaPermissionForEndpoint(evt) {

    let _this       = this,
        endpoint    = evt.endpoint;

    // Sanitize Path - Remove first and last slashes, if any
    endpoint.path = endpoint.path.split('/');
    endpoint.path = endpoint.path.join('/');

    // Create new access policy statement
    let params          = {};
    params.Action       = 'lambda:InvokeFunction';
    params.FunctionName =  evt.endpoint.lambda.FunctionArn;
    params.Principal    = 'apigateway.amazonaws.com';
    params.StatementId  = evt.endpoint.statementId;
    params.SourceArn    = 'arn:aws:execute-api:'
        + evt.region.region
        + ':'
        + evt.awsAccountNumber
        + ':'
        + evt.region.restApiId
        + '/*/'
        + endpoint.method
        + '/'
        + endpoint.path;

    return _this.Lambda.addPermissionPromised(params)
        .then(function(data) {

          SUtils.sDebug(
              '"'
              + evt.stage + ' - '
              + evt.region.region
              + ' - ' + evt.endpoint.path + '": '
              + 'added permission to Lambda');

          return evt;

        })
        .catch(function(error) {
          return endpoint;
        });
  }

}

module.exports = EndpointBuildApiGateway;