/*global module:false*/
module.exports = function(grunt) {
    // Project configuration
    grunt.initConfig({
      concat: {
        bundle: {
          src: [  // rosjs , eventemitter2
                'src/rosjs/ros.js','src/dist/eventemitter2.js',
                // actionlibjs
                'src/actionlibjs/actionclient.js',
                // nav2djs
                'src/nav2djs/nav2d.js',
                // map2djs
                'src/map2djs/map2djs',
                // mjpegcanvasjs
                'src/mjpegcanvasjs/mjpegcanvasjs.js'
            ],
          dest : 'dist/robotwebtools.js'
        }
      },
      min: {
        bundle : {
          src: ['<config:concat.bundle.dest>'],
          dest: 'dist/robotwebtools.min.js'
        }
      },
      uglify: {}
    });

    // Default task.
    grunt.registerTask('default','concat min');
};
