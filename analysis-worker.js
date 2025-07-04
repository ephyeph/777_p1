/**
 * analysis-worker.js - OPTIMIZED for Performance
 * Much faster spatial analysis with progress updates
 */

// Import libraries
importScripts('./lib/turf.min.js');
importScripts('./lib/simple-statistics.min.js');

/**
 * FASTER IDW - Uses coarser grid and optimized distance calculations
 */
function performFastIDW(wellData, bbox, power = 2) {
    console.log(`Starting FAST IDW with power=${power}`);
    
    const [west, south, east, north] = bbox;
    
    // Much coarser grid for speed - adjust based on your needs
    const cellSize = 0.05; // Larger cells = faster processing
    const gridPoints = [];
    
    // Create smaller grid (max ~1000 points instead of 10000+)
    for (let lon = west; lon <= east; lon += cellSize) {
        for (let lat = south; lat <= north; lat += cellSize) {
            gridPoints.push([lon, lat]);
        }
    }
    
    console.log(`Created FAST grid with ${gridPoints.length} points`);
    
    // Extract well data once
    const wellPoints = wellData.features.map(feature => {
        const [lon, lat] = feature.geometry.coordinates;
        const nitrate = feature.properties.nitr_ran || 0;
        return [lon, lat, nitrate];
    });
    
    // Faster IDW calculation
    const interpolatedValues = fastInterpolateIDW(wellPoints, gridPoints, power);
    
    // Create GeoJSON features
    const features = gridPoints.map((point, index) => {
        return turf.point(point, {
            idw: interpolatedValues[index]
        });
    });
    
    return turf.featureCollection(features);
}

/**
 * OPTIMIZED IDW algorithm - much faster
 */
function fastInterpolateIDW(wellPoints, gridPoints, power) {
    const results = [];
    const maxDistance = 0.3; // Smaller search radius for speed
    const maxPointsToUse = 8; // Limit points used per interpolation
    
    for (const [gx, gy] of gridPoints) {
        let numerator = 0;
        let denominator = 0;
        let nearestValue = 0;
        let nearestDistance = Infinity;
        let pointsUsed = 0;
        
        // Find nearby points efficiently
        const nearbyPoints = [];
        
        for (const [px, py, value] of wellPoints) {
            const deltaX = gx - px;
            const deltaY = gy - py;
            const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
            
            if (distance < nearestDistance) {
                nearestDistance = distance;
                nearestValue = value;
            }
            
            if (distance <= maxDistance) {
                nearbyPoints.push({ distance, value });
            }
        }
        
        // Sort and limit points for efficiency
        nearbyPoints.sort((a, b) => a.distance - b.distance);
        const pointsToUse = nearbyPoints.slice(0, maxPointsToUse);
        
        // Calculate IDW
        if (pointsToUse.length > 0) {
            for (const point of pointsToUse) {
                if (point.distance < 0.001) {
                    // Exact match
                    results.push(point.value);
                    pointsUsed = -1;
                    break;
                }
                const weight = 1 / Math.pow(point.distance, power);
                numerator += weight * point.value;
                denominator += weight;
            }
            
            if (pointsUsed !== -1) {
                results.push(denominator > 0 ? numerator / denominator : nearestValue);
            }
        } else {
            results.push(nearestValue);
        }
    }
    
    return results;
}

/**
 * MUCH FASTER Zonal Statistics using spatial indexing
 */
function fastAggregateByTracts(tractData, idwResult) {
    console.log('Starting FAST zonal aggregation');
    
    const updatedTracts = JSON.parse(JSON.stringify(tractData));
    let processedTracts = 0;
    
    // Send progress updates
    const totalTracts = updatedTracts.features.length;
    
    updatedTracts.features.forEach((tract, tractIndex) => {
        const nitrateValues = [];
        
        try {
            // Get tract bounding box for fast filtering
            const tractBounds = turf.bbox(tract);
            const [minX, minY, maxX, maxY] = tractBounds;
            
            // Pre-filter IDW points using bounding box (much faster)
            const candidatePoints = idwResult.features.filter(point => {
                const [x, y] = point.geometry.coordinates;
                return x >= minX && x <= maxX && y >= minY && y <= maxY;
            });
            
            // Only do expensive point-in-polygon on filtered candidates
            for (const idwPoint of candidatePoints) {
                if (turf.booleanPointInPolygon(idwPoint, tract)) {
                    nitrateValues.push(idwPoint.properties.idw);
                }
            }
            
            // Calculate statistics
            if (nitrateValues.length > 0) {
                const sum = nitrateValues.reduce((a, b) => a + b, 0);
                tract.properties.avg_nitrate = sum / nitrateValues.length;
                tract.properties.nitrate_point_count = nitrateValues.length;
            } else {
                tract.properties.avg_nitrate = 0;
                tract.properties.nitrate_point_count = 0;
            }
            
            processedTracts++;
            
            // Send progress update every 50 tracts
            if (processedTracts % 50 === 0) {
                self.postMessage({
                    type: 'progress',
                    message: `Processed ${processedTracts}/${totalTracts} census tracts`,
                    progress: (processedTracts / totalTracts) * 100
                });
            }
            
        } catch (error) {
            console.warn(`Error processing tract ${tractIndex}:`, error);
            tract.properties.avg_nitrate = 0;
            tract.properties.nitrate_point_count = 0;
        }
    });
    
    console.log(`FAST aggregation completed for ${processedTracts} tracts`);
    return updatedTracts;
}

/**
 * Enhanced regression with more statistics
 */
function performEnhancedRegression(tractData) {
    console.log('Starting enhanced regression analysis');
    
    const dataPairs = [];
    const tractInfo = [];
    
    tractData.features.forEach((tract, index) => {
        const nitrate = tract.properties.avg_nitrate;
        const cancerRate = tract.properties.canrate || tract.properties.cancer_rate || 0;
        const tractId = tract.properties.GEOID || tract.properties.TRACT || index;
        
        if (nitrate > 0 && cancerRate > 0 && 
            !isNaN(nitrate) && !isNaN(cancerRate) &&
            tract.properties.nitrate_point_count >= 1) {
            dataPairs.push([nitrate, cancerRate]);
            tractInfo.push({
                tractId: tractId,
                nitrate: nitrate,
                cancerRate: cancerRate,
                pointCount: tract.properties.nitrate_point_count
            });
        }
    });
    
    console.log(`Found ${dataPairs.length} valid data pairs for regression`);
    
    if (dataPairs.length < 3) {
        return null;
    }
    
    try {
        // Perform regression
        const regression = ss.linearRegression(dataPairs);
        const regressionLine = ss.linearRegressionLine(regression);
        const rSquared = ss.rSquared(dataPairs, regressionLine);
        
        // Calculate residuals
        const residuals = dataPairs.map(([x, y]) => {
            const predicted = regressionLine(x);
            return y - predicted;
        });
        
        // Enhanced statistics
        const nitrateValues = dataPairs.map(pair => pair[0]);
        const cancerValues = dataPairs.map(pair => pair[1]);
        
        const result = {
            // Basic regression
            m: regression.m,
            b: regression.b,
            rSquared: rSquared,
            n: dataPairs.length,
            
            // Enhanced statistics
            residuals: {
                values: residuals,
                mean: ss.mean(residuals),
                standardDeviation: ss.standardDeviation(residuals),
                min: ss.min(residuals),
                max: ss.max(residuals)
            },
            
            // Variable statistics
            nitrate: {
                mean: ss.mean(nitrateValues),
                min: ss.min(nitrateValues),
                max: ss.max(nitrateValues),
                std: ss.standardDeviation(nitrateValues)
            },
            
            cancer: {
                mean: ss.mean(cancerValues),
                min: ss.min(cancerValues),
                max: ss.max(cancerValues),
                std: ss.standardDeviation(cancerValues)
            },
            
            // Correlation
            correlation: ss.sampleCorrelation(nitrateValues, cancerValues),
            
            // Tract information for detailed analysis
            tractData: tractInfo
        };
        
        console.log('Enhanced regression completed');
        return result;
        
    } catch (error) {
        console.error('Error in regression analysis:', error);
        return null;
    }
}

/**
 * Main message handler - OPTIMIZED workflow
 */
self.onmessage = function(e) {
    console.log('Worker starting OPTIMIZED spatial analysis');
    
    try {
        const { wellData, tractData, k, bbox } = e.data;
        
        // Validation
        if (!wellData?.features || !tractData?.features || !bbox || !k) {
            throw new Error('Invalid input data');
        }
        
        if (typeof turf === 'undefined' || typeof ss === 'undefined') {
            throw new Error('Required libraries not loaded');
        }
        
        console.log(`OPTIMIZED processing: ${wellData.features.length} wells, ${tractData.features.length} tracts, k=${k}`);
        
        // Send initial progress
        self.postMessage({
            type: 'progress',
            message: 'Starting IDW interpolation...',
            progress: 10
        });
        
        // Step 1: FAST IDW interpolation
        const idwResult = performFastIDW(wellData, bbox, k);
        
        self.postMessage({
            type: 'progress',
            message: 'IDW complete. Starting zonal aggregation...',
            progress: 40
        });
        
        // Step 2: FAST zonal aggregation
        const updatedTractData = fastAggregateByTracts(tractData, idwResult);
        
        self.postMessage({
            type: 'progress',
            message: 'Aggregation complete. Running regression...',
            progress: 90
        });
        
        // Step 3: Enhanced regression
        const regressionResults = performEnhancedRegression(updatedTractData);
        
        self.postMessage({
            type: 'progress',
            message: 'Analysis complete!',
            progress: 100
        });
        
        console.log('OPTIMIZED analysis complete - sending results');
        
        // Send final results
        self.postMessage({
            type: 'complete',
            idwResult: idwResult,
            updatedTractData: updatedTractData,
            regressionResults: regressionResults
        });
        
    } catch (error) {
        console.error('Error in optimized worker:', error);
        
        self.postMessage({
            type: 'error',
            error: error.message,
            idwResult: null,
            updatedTractData: null,
            regressionResults: null
        });
    }
};