# Coverage Color Logic

## Problem
When multiple users wardrive the same area, their results can conflict. One user might get good coverage (green) while another gets no coverage (red). The original logic would flip colors based on the last sample.

## Solution: Success Rate Based Coloring
The map now uses a **success rate threshold system** that aggregates all samples from all users to show overall reliability.

### Color Thresholds

| Color | Success Rate | Meaning |
|-------|-------------|---------|
| 🟢 Bright Green | ≥80% | **Very Reliable** - Coverage works consistently |
| 🟢 Yellow-Green | 50-80% | **Usually Works** - Coverage is generally good |
| 🟡 Yellow | 30-50% | **Spotty** - Coverage is intermittent |
| 🟠 Orange | 10-30% | **Rarely Works** - Coverage is poor |
| 🔴 Red | <10% | **Dead Zone** - Coverage almost never works |
| ⚪ Gray | No pings | No ping data (GPS tracking only) |

### How It Works

1. **Data Collection**: Each user's ping attempts (success/failure) are stored
2. **Aggregation**: For each map square (geohash), all pings from all users are combined
3. **Success Rate**: `received / (received + lost)`
4. **Color Assignment**: Based on the thresholds above

### Example Scenarios

**Scenario 1: Consistent Coverage**
- User A: 10 successful pings, 0 failed
- User B: 8 successful pings, 1 failed
- **Result**: 18/19 = 95% success → 🟢 Bright Green

**Scenario 2: Your Dilemma**
- You: 5 successful pings, 0 failed
- Someone else: 0 successful pings, 3 failed
- **Result**: 5/8 = 62.5% success → 🟢 Yellow-Green (usually works)

**Scenario 3: Dead Zone**
- User A: 0 successful pings, 10 failed
- User B: 1 successful ping, 9 failed
- **Result**: 1/20 = 5% success → 🔴 Red (dead zone)

### Benefits

✅ **Fair Representation**: No single user can flip a square's color dramatically
✅ **Reliability Metric**: Shows how consistently coverage works
✅ **Confidence Building**: More samples = more accurate representation
✅ **Honest Coverage**: Shows spotty areas as yellow/orange, not just green/red

### Implementation

Both the Android app and web map use identical logic:
- **Android**: `lib/services/aggregation_service.dart`
- **Web**: `index.html` (getCoverageColor function)
- **API**: Stores `pingSuccess` boolean with each sample

### UI Features

- Popup shows success rate percentage (e.g., "75%")
- Popup shows received vs lost ping counts
- Legend shows all color meanings
- Sample count indicates confidence level
