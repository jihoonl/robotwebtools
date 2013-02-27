/**
 * Ros.js can be included using <script src="ros.js"> or AMD.  The next few
 * lines provide support for both formats and are based on the Universal Module
 * Definition.
 *
 * @see AMD - http://bryanforbes.github.com/amd-commonjs-modules-presentation/2011-10-29/
 * @see UMD - https://github.com/umdjs/umd/blob/master/amdWeb.js
 */
(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define(['eventemitter2'], factory);
  }
  else {
    root.ROS = factory(root.EventEmitter2);
  }
}(this, function (EventEmitter2) {

  /**
   * Manages connection to the server and all interactions with
   * ROS.
   *
   * Emits the following events:
   *  * 'error' - there was an error with ROS
   *  * 'connection' - connected to the WebSocket server
   *  * 'close' - disconnected to the WebSocket server
   *
   *  @constructor
   *  @param url (optional) - The WebSocket URL for rosbridge. Can be specified
   *    later with `connect`.
   */
  var ROS = function(url) {
    var ros = this;
    ros.socket = null;

    // Provides a unique ID for each message sent to the server.
    ros.idCounter = 0;

    // Socket Handling
    // ---------------

    /**
     * Emits a 'connection' event on WebSocket connection.
     */
    function onOpen(event) {
      ros.emit('connection', event);
    };

    /**
     * Emits a 'close' event on WebSocket disconnection.
     */
    function onClose(event) {
      ros.emit('close', event);
    };

    /**
     * Emits an 'error' event whenever there was an error.
     */
    function onError(event) {
      ros.emit('error', event);
    };

    /**
     * If a message was compressed as a PNG image (a compression hack since
     * gzipping over WebSockets is not supported yet), this function places the
     * "image" in a canvas element then decodes the "image" as a Base64 string.
     *
     * @param data - object containing the PNG data.
     * @param callback function with params:
     *   * data - the uncompressed data
     */
    function decompressPng(data, callback) {
      // Uncompresses the data before sending it through (use image/canvas to do so).
      var image = new Image();
      // When the image loads, extracts the raw data (JSON message).
      image.onload = function() {
        // Creates a local canvas to draw on.
        var canvas  = document.createElement('canvas');
        var context = canvas.getContext('2d');

        // Sets width and height.
        canvas.width = image.width;
        canvas.height = image.height;

        // Puts the data into the image.
        context.drawImage(image, 0, 0);
        // Grabs the raw, uncompressed data.
        var imageData = context.getImageData(0, 0, image.width, image.height).data;

        // Constructs the JSON.
        var jsonData = '';
        for (var i = 0; i < imageData.length; i += 4) {
          // RGB
          jsonData += String.fromCharCode(imageData[i], imageData[i+1], imageData[i+2]);
        }
        var decompressedData = JSON.parse(jsonData);
        callback(decompressedData);
      };
      // Sends the image data to load.
      image.src = 'data:image/png;base64,' + data.data;
    }

    /**
     * Parses message responses from rosbridge and sends to the appropriate
     * topic, service, or param.
     *
     * @param message - the raw JSON message from rosbridge.
     */
    function onMessage(message) {
      function handleMessage(message) {
        if (message.op === 'publish') {
          ros.emit(message.topic, message.msg);
        }
        else if (message.op === 'service_response') {
          ros.emit(message.id, message.values);
        }
      };

      var data = JSON.parse(message.data);
      if (data.op === 'png') {
        decompressPng(data, function(decompressedData) {
          handleMessage(decompressedData);
        });
      }
      else {
        handleMessage(data);
      }
    };

    /**
     * Sends the message over the WebSocket, but queues the message up if not
     * yet connected.
     */
    function callOnConnection(message) {
      var messageJson = JSON.stringify(message);

      if (ros.socket.readyState !== WebSocket.OPEN) {
        ros.once('connection', function() {
          ros.socket.send(messageJson);
        });
      }
      else {
        ros.socket.send(messageJson);
      }
    };

    /**
     * Connect to the specified WebSocket.
     *
     * @param url - WebSocket URL for Rosbridge
     */
    ros.connect = function(url) {
      ros.socket = new WebSocket(url);
      ros.socket.onopen    = onOpen;
      ros.socket.onclose   = onClose;
      ros.socket.onerror   = onError;
      ros.socket.onmessage = onMessage;
    };

    /**
     * Disconnect from the WebSocket server.
     */
    ros.close = function() {
      if (ros.socket) {
        ros.socket.close();
      }
    };

    if (url) {
      ros.connect(url);
    }

    // Topics
    // ------

    /**
     * Retrieves list of topics in ROS as an array.
     *
     * @param callback function with params:
     *   * topics - Array of topic names
     */
    ros.getTopics = function(callback) {
      var topicsClient = new ros.Service({
        name        : '/rosapi/topics',
        serviceType : 'rosapi/Topics'
      });

      var request = new ros.ServiceRequest();

      topicsClient.callService(request, function(result) {
        callback(result.topics);
      });
    };

    /**
     * Message objects are used for publishing and subscribing to and from
     * topics.
     * @param values - object matching the fields defined in the .msg
     *   definition file.
     */
    ros.Message = function(values) {
      var message = this;
      if (values) {
        Object.keys(values).forEach(function(name) {
          message[name] = values[name];
        });
      }
    };

    /**
     * Publish and/or subscribe to a topic in ROS.
     *
     * @constructor
     * @param options - object with following keys:
     *   * node - the name of the node to register under
     *   * name - the topic name, like /cmd_vel
     *   * messageType - the message type, like 'std_msgs/String'
     */
    ros.Topic = function(options) {
      var topic          = this;
      options            = options || {};
      topic.node         = options.node;
      topic.name         = options.name;
      topic.messageType  = options.messageType;
      topic.isAdvertised = false;
      topic.compression  = options.compression || 'none';
      topic.throttle_rate = options.throttle_rate || 0;

      // Check for valid compression types
      if (topic.compression && topic.compression !== 'png' && topic.compression !== 'none') {
        topic.emit('warning', topic.compression + ' compression is not supported. No comression will be used.');
      }

      // Check if throttle rate is negative
      if (topic.throttle_rate < 0) {
        topic.emit('warning',topic.throttle_rate + ' is not allowed. Set to 0');
        topic.throttle_rate = 0;
      }

      /**
       * Every time a message is published for the given topic, the callback
       * will be called with the message object.
       *
       * @param callback - function with the following params:
       *   * message - the published message
       */
      topic.subscribe = function(callback) {
        topic.on('message', function(message) {
          callback(message);
        });

        ros.on(topic.name, function(data) {
          var message = new ros.Message(data);
          topic.emit('message', message);
        });

        ros.idCounter++;
        var subscribeId = 'subscribe:' + topic.name + ':' + ros.idCounter;
        var call = {
          op          : 'subscribe',
          id          : subscribeId,
          type        : topic.messageType,
          topic       : topic.name,
          compression : topic.compression,
          throttle_rate : topic.throttle_rate
        };

        callOnConnection(call);
      };

      /**
       * Unregisters as a subscriber for the topic. Unsubscribing will remove
       * all subscribe callbacks.
       */
      topic.unsubscribe = function() {
        ros.removeAllListeners([topic.name]);
        ros.idCounter++;
        var unsubscribeId = 'unsubscribe:' + topic.name + ':' + ros.idCounter;
        var call = {
          op    : 'unsubscribe',
          id    : unsubscribeId,
          topic : topic.name
        };
        callOnConnection(call);
      };

      /**
       * Registers as a publisher for the topic.
       */
      topic.advertise = function() {
        ros.idCounter++;
        var advertiseId = 'advertise:' + topic.name + ':' + ros.idCounter;
        var call = {
          op    : 'advertise',
          id    : advertiseId,
          type  : topic.messageType,
          topic : topic.name
        };
        callOnConnection(call);
        topic.isAdvertised = true;
      };

      /**
       * Unregisters as a publisher for the topic.
       */
      topic.unadvertise = function() {
        ros.idCounter++;
        var unadvertiseId = 'unadvertise:' + topic.name + ':' + ros.idCounter;
        var call = {
          op    : 'unadvertise',
          id    : unadvertiseId,
          topic : topic.name
        };
        callOnConnection(call);
        topic.isAdvertised = false;
      };

      /**
       * Publish the message.
       *
       * @param message - A ROS.Message object.
       */
      topic.publish = function(message) {
        if (!topic.isAdvertised) {
          topic.advertise();
        }

        ros.idCounter++;
        var publishId = 'publish:' + topic.name + ':' + ros.idCounter;
        var call = {
          op    : 'publish',
          id    : publishId,
          topic : topic.name,
          msg   : message
        };
        callOnConnection(call);
      };
    };
    ros.Topic.prototype.__proto__ = EventEmitter2.prototype;

    // Services
    // --------

    /**
     * Retrieves list of active service names in ROS.
     *
     * @constructor
     * @param callback - function with the following params:
     *   * services - array of service names
     */
    ros.getServices = function(callback) {
      var servicesClient = new ros.Service({
        name        : '/rosapi/services',
        serviceType : 'rosapi/Services'
      });

      var request = new ros.ServiceRequest();

      servicesClient.callService(request, function(result) {
        callback(result.services);
      });
    };

    /**
     * A ServiceRequest is passed into the service call.
     *
     * @constructor
     * @param values - object matching the values of the request part from the
     *   .srv file.
     */
    ros.ServiceRequest = function(values) {
      var serviceRequest = this;
      if (values) {
        Object.keys(values).forEach(function(name) {
          serviceRequest[name] = values[name];
        });
      }
    };

    /**
     * A ServiceResponse is returned from the service call.
     *
     * @param values - object matching the values of the response part from the
     *   .srv file.
     */
    ros.ServiceResponse = function(values) {
      var serviceResponse = this;
      if (values) {
        Object.keys(values).forEach(function(name) {
          serviceResponse[name] = values[name];
        });
      }
    };

    /**
     * A ROS service client.
     *
     * @constructor
     * @params options - possible keys include:
     *   * name - the service name, like /add_two_ints
     *   * serviceType - the service type, like 'rospy_tutorials/AddTwoInts'
     */
    ros.Service = function(options) {
      var service         = this;
      options             = options || {};
      service.name        = options.name;
      service.serviceType = options.serviceType;

      // Calls the service. Returns the service response in the callback.
      service.callService = function(request, callback) {
        ros.idCounter++;
        serviceCallId = 'call_service:' + service.name + ':' + ros.idCounter;

        ros.once(serviceCallId, function(data) {
          var response = new ros.ServiceResponse(data);
          callback(response);
        });

        var requestValues = [];
        Object.keys(request).forEach(function(name) {
          requestValues.push(request[name]);
        });

        var call = {
          op      : 'call_service',
          id      : serviceCallId,
          service : service.name,
          args    : requestValues
        };
        callOnConnection(call);
      };
    };
    ros.Service.prototype.__proto__ = EventEmitter2.prototype;

    // Params
    // ------

    /**
     * Retrieves list of param names from the ROS Parameter Server.
     *
     * @param callback function with params:
     *  * params - array of param names.
     */
    ros.getParams = function(callback) {
      var paramsClient = new ros.Service({
        name        : '/rosapi/get_param_names'
      , serviceType : 'rosapi/GetParamNames'
      });

      var request = new ros.ServiceRequest();
      paramsClient.callService(request, function(result) {
        callback(result.names);
      });
    };

    /**
     * A ROS param.
     *
     * @constructor
     * @param options - possible keys include:
     *   *name - the param name, like max_vel_x
     */
    ros.Param = function(options) {
      var param  = this;
      options    = options || {};
      param.name = options.name;

      /**
       * Fetches the value of the param.
       *
       * @param callback - function with the following params:
       *  * value - the value of the param from ROS.
       */
      param.get = function(callback) {
        var paramClient = new ros.Service({
          name        : '/rosapi/get_param',
          serviceType : 'rosapi/GetParam'
        });

        var request = new ros.ServiceRequest({
          name  : param.name,
          value : JSON.stringify('')
        });

        paramClient.callService(request, function(result) {
          var value = JSON.parse(result.value);
          callback(value);
        });
      };

      /**
       * Sets the value of the param in ROS.
       *
       * @param value - value to set param to.
       */
      param.set = function(value) {
        var paramClient = new ros.Service({
          name        : '/rosapi/set_param',
          serviceType : 'rosapi/SetParam'
        });

        var request = new ros.ServiceRequest({
          name: param.name,
          value: JSON.stringify(value)
        });

        paramClient.callService(request, function() {});
      };
    };
    ros.Param.prototype.__proto__ = EventEmitter2.prototype;

  };
  ROS.prototype.__proto__ = EventEmitter2.prototype;

  return ROS;
}));


(function (root, factory) {
    if(typeof define === 'function' && define.amd) {
        define(['eventemitter2'],factory);
    }
    else {
        root.ActionClient = factory(root.EventEmitter2);
    }
}(this, function(EventEmitter2) {

var ActionClient = function(options) {
  var actionClient = this;
  options = options || {};
  actionClient.ros         = options.ros;
  actionClient.serverName  = options.serverName;
  actionClient.actionName  = options.actionName;
  actionClient.timeout     = options.timeout;
  actionClient.goals       = {};

  actionClient.goalTopic = new actionClient.ros.Topic({
    name        : actionClient.serverName + '/goal'
  , messageType : actionClient.actionName + 'Goal'
  });
  actionClient.goalTopic.advertise();

  actionClient.cancelTopic = new actionClient.ros.Topic({
    name        : actionClient.serverName + '/cancel'
  , messageType : 'actionlib_msgs/GoalID'
  });
  actionClient.cancelTopic.advertise();

  var receivedStatus = false;
  var statusListener = new actionClient.ros.Topic({
    name        : actionClient.serverName + '/status'
  , messageType : 'actionlib_msgs/GoalStatusArray'
  });
  statusListener.subscribe(function (statusMessage) {
    receivedStatus = true;

    statusMessage.status_list.forEach(function(status) {
      var goal = actionClient.goals[status.goal_id.id];
      if (goal) {
        goal.emit('status', status);
      }
    });
  });

  // If timeout specified, emit a 'timeout' event if the ActionServer does not
  // respond before the timeout.
  if (actionClient.timeout) {
    setTimeout(function() {
      if (!receivedStatus) {
        actionClient.emit('timeout');
      }
    }, actionClient.timeout);
  }

  // Subscribe to the feedback, and result topics
  var feedbackListener = new actionClient.ros.Topic({
    name        : actionClient.serverName + '/feedback'
  , messageType : actionClient.actionName + 'Feedback'
  });
  feedbackListener.subscribe(function (feedbackMessage) {
    var goal = actionClient.goals[feedbackMessage.status.goal_id.id];

    if (goal) {
      goal.emit('status', feedbackMessage.status);
      goal.emit('feedback', feedbackMessage.feedback);
    }
  });

  var resultListener = new actionClient.ros.Topic({
    name        : actionClient.serverName + '/result'
  , messageType : actionClient.actionName + 'Result'
  });
  resultListener.subscribe(function (resultMessage) {
    var goal = actionClient.goals[resultMessage.status.goal_id.id];

    if (goal) {
      goal.emit('status', resultMessage.status);
      goal.emit('result', resultMessage.result);
    }
  });

  actionClient.cancel = function() {
    var cancelMessage = new actionClient.ros.Message({});
    actionClient.cancelTopic.publish(cancelMessage);
  };

  actionClient.Goal = function(goalMsg) {
    var goal = this;

    goal.isFinished = false;
    goal.status;
    goal.result;
    goal.feedback;

    var date = new Date();
    goal.goalId = 'goal_' + Math.random() + "_" + date.getTime();
    goal.goalMessage = new actionClient.ros.Message({
      goal_id : {
        stamp: {
          secs  : 0
        , nsecs : 0
        }
      , id: goal.goalId
      }
    , goal: goalMsg
    });

    goal.on('status', function(status) {
      goal.status = status;
    });

    goal.on('result', function(result) {
      goal.isFinished = true;
      goal.result = result;
    });

    goal.on('feedback', function(feedback) {
      goal.feedback = feedback;
    });

    actionClient.goals[goal.goalId] = this;

    goal.send = function(timeout) {
      actionClient.goalTopic.publish(goal.goalMessage);
      if (timeout) {
         setTimeout(function() {
           if (!goal.isFinished) {
             goal.emit('timeout');
           }
         }, timeout);
      }
    };

    goal.cancel = function() {
      var cancelMessage = new actionClient.ros.Message({
        id: goal.goalId
      });
      actionClient.cancelTopic.publish(cancelMessage);
    };
  };
  actionClient.Goal.prototype.__proto__ = EventEmitter2.prototype;

};
ActionClient.prototype.__proto__ = EventEmitter2.prototype;
return ActionClient;
}
));

/**
 * Author: Russell Toris
 * Version: October 8, 2012
 *  
 * Converted to AMD by Jihoon Lee
 * Version: September 27, 2012
 */

(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([ 'eventemitter2', 'actionclient', 'map' ], factory);
  } else {
    root.Nav2D = factory(root.EventEmitter2, root.ActionClient, root.Map);
  }
}
    (
        this,
        function(EventEmitter2, ActionClient, Map) {
          var Nav2D = function(options) {
            var nav2D = this;
            options = options || {};
            nav2D.ros = options.ros;
            nav2D.serverName = options.serverName || '/move_base';
            nav2D.actionName = options.actionName
                || 'move_base_msgs/MoveBaseAction';
            nav2D.serverTimeout = options.serverTimeout || 5000;
            nav2D.mapTopic = options.mapTopic || '/map';
            nav2D.continuous = options.continuous;
            nav2D.canvasID = options.canvasID;
            // optional (used if you do not want to stream /map or use a custom image)
            nav2D.image = options.image;
            nav2D.mapMetaTopic = options.mapMetaTopic || '/map_metadata';
            // optional color settings
            nav2D.clickColor = options.clickColor || '#543210';
            nav2D.robotColor = options.robotColor || '#012345';
            nav2D.initialPoseTopic = options.initialPoseTopic || '/initialpose';
            nav2D.readOnly = options.readOnly;

            // draw robot 
            nav2D.drawrobot = options.drawrobot;
            
            nav2D.mode = 'none';
            
            // current robot pose message
            nav2D.robotPose = null;
            // current goal
            nav2D.goalMessage = null;

            // icon information for displaying robot and click positions
            var clickRadius = 1;
            var clickUpdate = true;
            var maxClickRadius = 5;
            var robotRadius = 1;
            var robotRadiusGrow = true;
            var maxRobotRadius = 10;

            // position information
            var robotX;
            var robotY;
            var robotRotZ;
            var clickX;
            var clickY;

            // map and metadata
            var map = null;
            var mapWidth = null;
            var mapHeight = null;
            var mapResolution = null;
            var mapX;
            var mapY;
            var drawInterval;

            // flag to see if everything (map image, metadata, and robot pose) is available
            var available = false;

            // grab the canvas
            var canvas = document.getElementById(nav2D.canvasID);

            // check if we need to fetch a map or if an image was provided
            if (nav2D.image) {
              // set the image
              map = new Image();
              map.src = nav2D.image;

              // get the meta information
              var metaListener = new nav2D.ros.Topic({
                name : nav2D.mapMetaTopic,
                messageType : 'nav_msgs/MapMetaData'
              });
              metaListener.subscribe(function(metadata) {
                // set the metadata
                mapWidth = metadata.width;
                mapHeight = metadata.height;
                mapResolution = metadata.resolution;
                mapX = metadata.origin.position.x;
                mapY = metadata.origin.position.y;

                // we only need the metadata once
                metaListener.unsubscribe();
              });
            } else {
              // create a map object
              var mapFetcher = new Map({
                ros : nav2D.ros,
                mapTopic : nav2D.mapTopic,
                continuous : nav2D.continuous
              });
              mapFetcher.on('available', function() {
                // store the image
                map = mapFetcher.image;

                // set the metadata
                mapWidth = mapFetcher.info.width;
                mapHeight = mapFetcher.info.height;
                mapResolution = mapFetcher.info.resolution;
                mapX = mapFetcher.info.origin.position.x;
                mapY = mapFetcher.info.origin.position.y;
              });
            }

            // setup a listener for the robot pose
            var poseListener = new nav2D.ros.Topic({
              name : '/robot_pose',
              messageType : 'geometry_msgs/Pose',
              throttle_rate : 100,
            });
            poseListener
                .subscribe(function(pose) {
                  // set the public field
                  nav2D.robotPose = pose;
                  
                  // only update once we know the map metadata
                  if (mapWidth && mapHeight && mapResolution) {
                    // get the current canvas size
                    var canvasWidth = canvas.getAttribute('width');
                    var canvasHeight = canvas.getAttribute('height');

                    // set the pixel location with (0, 0) at the top left
                    robotX = ((pose.position.x - mapX) / mapResolution)
                        * (canvasWidth / mapWidth);
                    robotY = canvasHeight
                        - (((pose.position.y - mapY) / mapResolution) * (canvasHeight / mapHeight));

                    // get the rotation Z
                    var q0 = pose.orientation.w;
                    var q1 = pose.orientation.x;
                    var q2 = pose.orientation.y;
                    var q3 = pose.orientation.z;
                    
                    robotRotZ = -Math.atan2(2 * ( q0 * q3 + q1 * q2) , 1 - 2 * (Math.pow(q2,2) +Math.pow(q3,2)));

                    // check if this is the first time we have all information
                    if (!available) {
                      available = true;
                      // notify the user we are available
                      nav2D.emit('available');
                    }
                  }
                });

            // setup the actionlib client
            var actionClient = new ActionClient({
              ros : nav2D.ros,
              actionName : nav2D.actionName,
              serverName : nav2D.serverName,
              timeout : nav2D.serverTimeout
            });
            // pass the event up
            actionClient.on('timeout', function() {
              nav2D.emit('timeout');
            });

            // create a cancel
            nav2D.cancel = function() {
              actionClient.cancel();
            };

            nav2D.drawrobot = nav2D.drawrobot || function(context,robotX,robotY) {
              context.fillStyle = nav2D.robotColor;
              context.beginPath();
              context.arc(robotX, robotY, robotRadius, 0, Math.PI * 2, true);
              context.closePath();
              context.fill();

              // grow and shrink the icon
              if (robotRadiusGrow) {
                robotRadius++;
              } else {
                robotRadius--;
              }
              if (robotRadius == maxRobotRadius || robotRadius == 1) {
                robotRadiusGrow = !robotRadiusGrow;
              }
            };

            // create the draw function
            var draw = function() {
              // grab the drawing context
              var context = canvas.getContext('2d');

              // grab the current sizes
              var width = canvas.getAttribute('width');
              var height = canvas.getAttribute('height');

              // check if we have the info we need
              var waiting = '';
              if (!map) {
                waiting = 'Waiting for the robot\'s internal map...';
              } else if (!mapResolution) {
                waiting = 'Waiting for the robot\'s map metadata...';
              } else if (!robotX || !robotY) {
                waiting = 'Waiting for the robot\'s position...';
              }

              context.clearRect(0, 0, width, height);

              if (waiting.length === 0) {
                // add the image back to the canvas
                context.drawImage(map, 0, 0, width, height);

                // check if the user clicked yet
                if (clickX && clickY && nav2D.mode == 'none') {
                  // draw the click point
                  context.fillStyle = nav2D.clickColor;
                  context.beginPath();
                  context.arc(clickX, clickY, clickRadius, 0, Math.PI * 2,true);
                  context.closePath();
                  context.fill();

                  // grow half the speed of the refresh rate
                  if (clickUpdate) {
                    clickRadius++;
                  }

                  // reset at the threshold (i.e., blink)
                  if (clickRadius == maxClickRadius) {
                    clickRadius = 1;
                  }

                  clickUpdate = !clickUpdate;
                }

                // draw the robot location
                nav2D.drawrobot(context,robotX,robotY,robotRotZ);
              } else {
                // let the user know what we need
                canvas.style.background = '#333333';
                // set the text
                context.lineWidth = 4;
                context.fillStyle = '#ffffff';
                context.font = '40px sans-serif';
                context.textAlign = 'center';
                context.textBaseline = 'middle';
                context.fillText(waiting, width / 2, height / 2);
              }
            };

            // get the position in the world from a point clicked by the user
            nav2D.getPoseFromEvent = function(event) {
              // only go if we have the map data
              if (available) {
                // get the y location with (0, 0) at the top left
                var offsetLeft = 0;
                var offsetTop = 0;
                var element = canvas;
                while (element && !isNaN(element.offsetLeft)
                    && !isNaN(element.offsetTop)) {
                  offsetLeft += element.offsetLeft - element.scrollLeft;
                  offsetTop += element.offsetTop - element.scrollTop;
                  element = element.offsetParent;
                }
                clickX = event.pageX - offsetLeft;
                clickY = event.pageY - offsetTop;

                // convert the pixel location to a pose
                var canvasWidth = canvas.getAttribute('width');
                var canvasHeight = canvas.getAttribute('height');
                var x = (clickX * (mapWidth / canvasWidth) * mapResolution)
                    + mapX;
                var y = ((canvasHeight - clickY) * (mapHeight / canvasHeight) * mapResolution)
                    + mapY;
                return [ x, y ];
              } else {
                return null;
              }
            };

            // a function to send the robot to the given goal location
            nav2D.sendGoalPose = function(x, y) {
              // create a goal
              var goal = new actionClient.Goal({
                target_pose : {
                  header : {
                    frame_id : '/map'
                  },
                  pose : {
                    position : {
                      x : x,
                      y : y,
                      z : 0
                    },
                    orientation : {
                      x : 0,
                      y : 0,
                      z : 0,
                      w : 1.0
                    }
                  }
                }
              });
              goal.send();
              
              nav2D.goalMessage = goal.goalMessage;

              // pass up the events to the user
              goal.on('result', function(result) {
                nav2D.emit('result', result);
                nav2D.mode = 'none';

                // clear the click icon
                clickX = null;
                clickY = null;
              });
              goal.on('status', function(status) {
                nav2D.emit('status', status);
              });
              goal.on('feedback', function(feedback) {
                nav2D.emit('feedback', feedback);
              });
            };


           canvas.addEventListener('click',function(event) {
             if(nav2D.mode == 'none') {           }
             else if(nav2D.mode == 'init') 
             {
               var poses = nav2D.getPoseFromEvent(event);
               if (poses != null) {
                 nav2D.sendInitPose(poses[0], poses[1]);
               } else {
                 nav2D.emit('error',"All of the necessary navigation information is not yet available."); 
               }
             }
             else if(nav2D.mode == 'goal') {
               var poses = nav2D.getPoseFromEvent(event);
               if (poses != null) {
                 nav2D.sendGoalPose(poses[0], poses[1]);
               } else {
                 nav2D.emit('error',"All of the necessary navigation information is not yet available.");
               }
             }
             else {
               nav2D.emit('error',"Wrong mode..");
             }
             nav2D.mode = 'none';
            });

            nav2D.setmode = function(mode) {
              nav2D.mode = mode;
              clickX = null;
              clickY = null;
            };

            nav2D.initPosePub = new nav2D.ros.Topic({
              name : nav2D.initialPoseTopic,
              type : 'geometry_msgs/PoseWithCovarianceStamped',
            });

            nav2D.sendInitPose = function(x,y) {
              var pose_msg = new ros.Message({
                header : {
                    frame_id : '/map'
                },
                pose : {
                  pose : {
                    position: {
                      x : x,
                      y : y,
                      z : 0,
                    },
                    orientation : {
                      x : 0,
                      y : 0,
                      z : 0,
                      w : 1,
                    },
                  },
                  covariance: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0]
                },
              });
              nav2D.initPosePub.publish(pose_msg);
              nav2D.setmode('none');
            };

            // check for read only
            if(!nav2D.readOnly) {
              canvas
                  .addEventListener(
                      'dblclick',
                      function(event) {
                        var poses = nav2D.getPoseFromEvent(event);
                        if (poses != null) {
                          nav2D.sendGoalPose(poses[0], poses[1]);
                        } else {
                          nav2D
                              .emit('error',
                                  "All of the necessary navigation information is not yet available.");
                        }
                      });
            }
            
            // set the interval for the draw function
            drawInterval = setInterval(draw, 30);
          };
          Nav2D.prototype.__proto__ = EventEmitter2.prototype;
          return Nav2D;
        }));
