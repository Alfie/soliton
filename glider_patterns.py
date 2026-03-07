#!/usr/bin/env python3
"""
glider_patterns.py

Generate Rule 110 glider patterns relative to the complex ether background.

The ether is the 14-bit repeating pattern: 00010011011111
Gliders are stable perturbations that propagate through the ether.

Strategy:
1. Initialize space with ether + small perturbation
2. Evolve both ether and perturbed state
3. XOR to detect glider (non-ether cells)
4. Track glider stability, propagation, growth
"""

import json
from typing import List, Tuple, Optional

# Rule 110 lookup table
RULE_110 = [0, 1, 1, 1, 0, 1, 1, 0]

# The 14-bit complex ether pattern
ETHER_PATTERN = [0, 0, 0, 1, 0, 0, 1, 1, 0, 1, 1, 1, 1, 1]

def rule110_lookup(left: int, center: int, right: int) -> int:
    """Apply Rule 110 to a 3-cell neighborhood."""
    index = (left << 2) | (center << 1) | right
    return RULE_110[index]

def evolve_once(cells: List[int], left_boundary: int = 0, right_boundary: int = 0) -> List[int]:
    """Evolve a row one generation using Rule 110."""
    width = len(cells)
    next_cells = []
    
    for i in range(width):
        left = cells[i - 1] if i > 0 else left_boundary
        center = cells[i]
        right = cells[i + 1] if i < width - 1 else right_boundary
        
        next_cells.append(rule110_lookup(left, center, right))
    
    return next_cells

def generate_ether(width: int, phase: int = 0) -> List[int]:
    """Generate ether pattern of given width starting at given phase."""
    ether = []
    for i in range(width):
        ether.append(ETHER_PATTERN[(i + phase) % len(ETHER_PATTERN)])
    return ether

def cells_to_int(cells: List[int]) -> int:
    """Convert cell list to packed integer (LSB = cell 0)."""
    result = 0
    for i, cell in enumerate(cells):
        if cell:
            result |= (1 << i)
    return result

def int_to_cells(value: int, width: int) -> List[int]:
    """Convert packed integer to cell list."""
    return [(value >> i) & 1 for i in range(width)]

def xor_lists(a: List[int], b: List[int]) -> List[int]:
    """XOR two cell lists."""
    return [x ^ y for x, y in zip(a, b)]

def count_nonzero(cells: List[int]) -> int:
    """Count non-zero cells."""
    return sum(cells)

def get_bounds(cells: List[int]) -> Tuple[Optional[int], Optional[int]]:
    """Get bounding box of active cells."""
    active = [i for i, cell in enumerate(cells) if cell]
    if not active:
        return None, None
    return min(active), max(active)

def apply_perturbation(ether: List[int], perturbation_type: str, position: int) -> List[int]:
    """
    Apply a small perturbation to ether background.
    
    Types:
    - 'flip_1': flip single cell
    - 'flip_2_adj': flip two adjacent cells
    - 'flip_2_gap': flip two cells with 1-cell gap
    """
    perturbed = ether[:]
    
    if perturbation_type == 'flip_1':
        if 0 <= position < len(perturbed):
            perturbed[position] ^= 1
    
    elif perturbation_type == 'flip_2_adj':
        if 0 <= position < len(perturbed) - 1:
            perturbed[position] ^= 1
            perturbed[position + 1] ^= 1
    
    elif perturbation_type == 'flip_2_gap':
        if 0 <= position < len(perturbed) - 2:
            perturbed[position] ^= 1
            perturbed[position + 2] ^= 1
    
    return perturbed

def analyze_glider(glider_history: List[List[int]]) -> dict:
    """
    Analyze a glider's properties over its evolution.
    
    Returns metrics:
    - is_stable: doesn't decay to zero
    - max_width: maximum bounding box width
    - avg_size: average number of non-ether cells
    - propagation: does it move left/right/stay?
    """
    if not glider_history or len(glider_history) < 3:
        return None
    
    # Check stability (doesn't vanish)
    final_size = count_nonzero(glider_history[-1])
    if final_size == 0:
        return None  # Decayed to ether
    
    # Track bounding box and size over time
    widths = []
    sizes = []
    centers = []
    
    for gen in glider_history:
        min_idx, max_idx = get_bounds(gen)
        if min_idx is not None:
            width = max_idx - min_idx + 1
            size = count_nonzero(gen)
            center = (min_idx + max_idx) / 2.0
            
            widths.append(width)
            sizes.append(size)
            centers.append(center)
    
    if not widths:
        return None
    
    # Detect propagation direction
    if len(centers) >= 2:
        center_delta = centers[-1] - centers[0]
        if center_delta > 1:
            propagation = 'right'
        elif center_delta < -1:
            propagation = 'left'
        else:
            propagation = 'stationary'
    else:
        propagation = 'unknown'
    
    return {
        'is_stable': final_size > 0,
        'max_width': max(widths),
        'min_width': min(widths),
        'avg_size': sum(sizes) / len(sizes),
        'final_size': sizes[-1],
        'propagation': propagation,
        'center_drift': centers[-1] - centers[0] if len(centers) >= 2 else 0,
        'persistence': len([s for s in sizes if s > 0]),
    }

def generate_glider_pattern(
    width: int,
    ether_phase: int,
    perturbation_type: str,
    perturb_position: int,
    max_gens: int
) -> Optional[dict]:
    """
    Generate a glider pattern by perturbing ether and tracking evolution.
    
    Returns None if perturbation decays to ether.
    Returns glider data if stable pattern emerges.
    """
    # Initialize with ether + perturbation
    ether = generate_ether(width, ether_phase)
    state = apply_perturbation(ether, perturbation_type, perturb_position)
    
    # Track both ether and state evolution
    ether_history = [ether[:]]
    state_history = [state[:]]
    glider_history = [xor_lists(state, ether)]  # Glider = state XOR ether
    
    for _ in range(max_gens - 1):
        ether = evolve_once(ether, 0, 0)
        state = evolve_once(state, 0, 0)
        glider = xor_lists(state, ether)
        
        ether_history.append(ether[:])
        state_history.append(state[:])
        glider_history.append(glider[:])
    
    # Analyze the glider
    metrics = analyze_glider(glider_history)
    
    if metrics is None:
        return None  # Decayed to ether
    
    # Extract active region to minimize pattern size
    all_active = []
    for gen in glider_history:
        all_active.extend([i for i, cell in enumerate(gen) if cell])
    
    if not all_active:
        return None
    
    min_idx = min(all_active)
    max_idx = max(all_active)
    
    # Trim to active region
    trimmed_glider = [gen[min_idx:max_idx + 1] for gen in glider_history]
    trimmed_state = [gen[min_idx:max_idx + 1] for gen in state_history]
    
    # Convert to packed integers
    glider_packed = [cells_to_int(gen) for gen in trimmed_glider]
    state_packed = [cells_to_int(gen) for gen in trimmed_state]
    
    return {
        'perturbation_type': perturbation_type,
        'perturb_position': perturb_position,
        'ether_phase': ether_phase,
        'glider_pattern': glider_packed,
        'state_pattern': state_packed,
        'metrics': metrics,
        'trimmed_width': len(trimmed_glider[0]) if trimmed_glider else 0,
    }

def generate_all_gliders(width: int = 64, max_gens: int = 30) -> dict:
    """
    Generate all unique glider patterns by systematically perturbing ether.
    """
    gliders = {}
    glider_set = set()  # For deduplication
    
    print(f"Generating gliders with width={width}, max_gens={max_gens}")
    print(f"Ether pattern: {''.join(map(str, ETHER_PATTERN))}")
    print()
    
    perturbation_types = ['flip_1', 'flip_2_adj', 'flip_2_gap']
    
    # Try different ether phases (0-13, since ether is 14 bits)
    for phase in range(len(ETHER_PATTERN)):
        print(f"Phase {phase}/{len(ETHER_PATTERN) - 1}...", end=' ')
        phase_count = 0
        
        for perturb_type in perturbation_types:
            for position in range(width - 2):  # Leave room for gap perturbations
                glider = generate_glider_pattern(
                    width, phase, perturb_type, position, max_gens
                )
                
                if glider:
                    # Deduplicate by glider pattern
                    pattern_tuple = tuple(glider['glider_pattern'])
                    if pattern_tuple not in glider_set:
                        glider_set.add(pattern_tuple)
                        
                        key = f"phase{phase}_{perturb_type}_pos{position}"
                        gliders[key] = glider
                        phase_count += 1
        
        print(f"found {phase_count} unique gliders")
    
    print(f"\nTotal unique gliders: {len(gliders)}")
    return gliders

def visualize_glider(glider_data: dict, name: str, max_rows: int = 20):
    """Visualize a glider pattern."""
    print(f"\nGlider: {name}")
    print(f"  Perturbation: {glider_data['perturbation_type']} at position {glider_data['perturb_position']}")
    print(f"  Ether phase: {glider_data['ether_phase']}")
    
    metrics = glider_data['metrics']
    print(f"  Metrics:")
    print(f"    - Propagation: {metrics['propagation']}")
    print(f"    - Max width: {metrics['max_width']}")
    print(f"    - Avg size: {metrics['avg_size']:.1f} cells")
    print(f"    - Persistence: {metrics['persistence']} generations")
    
    print(f"  Pattern (glider only, non-ether cells):")
    glider_pattern = glider_data['glider_pattern']
    width = glider_data['trimmed_width']
    
    for i, packed in enumerate(glider_pattern[:max_rows]):
        cells = int_to_cells(packed, width)
        line = ''.join(['█' if cell else '·' for cell in cells])
        print(f"    gen {i:2d}: {line}")
    
    if len(glider_pattern) > max_rows:
        print(f"    ... ({len(glider_pattern) - max_rows} more generations)")

def main():
    # Generate all gliders
    gliders = generate_all_gliders(width=64, max_gens=30)
    
    # Rank by interesting properties
    ranked = sorted(
        gliders.items(),
        key=lambda x: (
            x[1]['metrics']['max_width'],
            x[1]['metrics']['persistence']
        ),
        reverse=True
    )
    
    print("\n" + "="*70)
    print("TOP 10 GLIDERS (by max width + persistence)")
    print("="*70)
    
    for i, (key, glider) in enumerate(ranked[:10]):
        metrics = glider['metrics']
        print(f"\n{i+1}. {key}")
        print(f"   Width: {metrics['min_width']}-{metrics['max_width']} cells")
        print(f"   Size: {metrics['avg_size']:.1f} avg, {metrics['final_size']} final")
        print(f"   Propagation: {metrics['propagation']} (drift: {metrics['center_drift']:.1f})")
        print(f"   Persistence: {metrics['persistence']}/{len(glider['glider_pattern'])} gens")
    
    # Visualize top 3
    print("\n" + "="*70)
    print("TOP 3 GLIDER VISUALIZATIONS")
    print("="*70)
    
    for i, (key, glider) in enumerate(ranked[:3]):
        visualize_glider(glider, key, max_rows=15)
        if i < 2:
            print()
    
    # Save to JSON
    output = {
        "metadata": {
            "rule": "Rule 110",
            "ether_pattern": "".join(map(str, ETHER_PATTERN)),
            "width": 64,
            "max_generations": 30,
            "glider_count": len(gliders)
        },
        "gliders": gliders
    }
    
    with open('glider_patterns.json', 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"\n\nSaved {len(gliders)} gliders to glider_patterns.json")

if __name__ == '__main__':
    main()
