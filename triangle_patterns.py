#!/usr/bin/env python3
"""
triangle_patterns.py

Generate the complete library of Rule 110 triangle patterns.
These patterns start from small seeds (1-2 cells) and grow into
the characteristic expanding triangular shapes.

Output: JSON file with pattern signatures for Aho-Corasick matching
"""

import json
from typing import List, Tuple, Set

# Rule 110 lookup table
# Index is 3-bit neighborhood: (left << 2) | (center << 1) | right
RULE_110 = [0, 1, 1, 1, 0, 1, 1, 0]

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

def extract_active_region(generations: List[List[int]]) -> Tuple[int, int]:
    """Find the bounding box of active cells across all generations."""
    if not generations:
        return 0, 0
    
    min_idx = len(generations[0])
    max_idx = 0
    
    for gen in generations:
        for i, cell in enumerate(gen):
            if cell:
                min_idx = min(min_idx, i)
                max_idx = max(max_idx, i)
    
    return min_idx, max_idx + 1

def is_triangle_pattern(generations: List[List[int]]) -> bool:
    """
    Check if a pattern is triangular:
    - Starts from 1-2 cells
    - Has some activity in later generations (not dead)
    - Bounding box expands (pattern grows outward)
    """
    if len(generations) < 3:
        return False
    
    # Check seed is small
    seed_count = sum(generations[0])
    if seed_count > 2 or seed_count == 0:
        return False
    
    # Check pattern doesn't die out
    final_count = sum(generations[-1])
    if final_count == 0:
        return False
    
    # Check bounding box expansion
    def get_bounds(gen):
        active = [i for i, cell in enumerate(gen) if cell]
        if not active:
            return None, None
        return min(active), max(active)
    
    start_min, start_max = get_bounds(generations[0])
    end_min, end_max = get_bounds(generations[-1])
    
    if start_min is None or end_min is None:
        return False
    
    # Bounding box should expand (triangle-like growth)
    start_width = start_max - start_min + 1
    end_width = end_max - end_min + 1
    
    return end_width > start_width

def generate_pattern(seed: int, width: int, generations: int) -> List[int]:
    """
    Generate a pattern starting from a seed, return as packed integers.
    Returns None if not a valid triangle.
    """
    cells = int_to_cells(seed, width)
    history = [cells[:]]
    
    for _ in range(generations - 1):
        cells = evolve_once(cells, 0, 0)
        history.append(cells[:])
    
    # Check if it's a triangle pattern
    if not is_triangle_pattern(history):
        return None
    
    # Extract active region to minimize pattern size
    min_idx, max_idx = extract_active_region(history)
    trimmed = [gen[min_idx:max_idx] for gen in history]
    
    # Convert to packed integers
    return [cells_to_int(gen) for gen in trimmed]

def analyze_pattern_metrics(generations: List[List[int]]) -> dict:
    """Calculate scoring metrics for a pattern."""
    def get_bounds(gen):
        active = [i for i, cell in enumerate(gen) if cell]
        if not active:
            return None, None, 0
        return min(active), max(active), len(active)
    
    initial_min, initial_max, initial_count = get_bounds(generations[0])
    final_min, final_max, final_count = get_bounds(generations[-1])
    
    if initial_min is None or final_min is None:
        return None
    
    initial_width = initial_max - initial_min + 1
    final_width = final_max - final_min + 1
    
    # Track max width reached
    max_width = 0
    for gen in generations:
        _, max_idx, _ = get_bounds(gen)
        if max_idx is not None:
            _, min_idx, _ = get_bounds(gen)
            width = max_idx - min_idx + 1
            max_width = max(max_width, width)
    
    return {
        "initial_width": initial_width,
        "final_width": final_width,
        "max_width": max_width,
        "width_growth": final_width - initial_width,
        "persistence": len([g for g in generations if sum(g) > 0]),
        "initial_cells": initial_count,
        "final_cells": final_count,
    }

def generate_all_patterns(max_width: int = 64, max_gens: int = 20) -> dict:
    """
    Generate all unique triangle patterns.
    
    Strategy:
    - Try all 1-cell seeds
    - Try all 2-cell seeds (adjacent and separated by 1)
    - Evolve for max_gens generations
    - Filter for triangle patterns
    - Deduplicate
    """
    patterns = {}
    pattern_set = set()  # For deduplication
    
    print(f"Generating patterns with width={max_width}, max_gens={max_gens}")
    
    # 1-cell seeds
    print("Trying 1-cell seeds...")
    for pos in range(max_width):
        seed = 1 << pos
        pattern = generate_pattern(seed, max_width, max_gens)
        
        if pattern:
            # Reconstruct for metrics
            cells_history = [int_to_cells(g, max_width) for g in pattern]
            metrics = analyze_pattern_metrics(cells_history)
            
            if metrics:
                pattern_tuple = tuple(pattern)
                if pattern_tuple not in pattern_set:
                    pattern_set.add(pattern_tuple)
                    
                    # Mark rightmost seeds specially (classic triangles)
                    is_rightmost = pos >= max_width - 4
                    
                    patterns[f"single_cell_{pos}"] = {
                        "seed": hex(seed),
                        "seed_position": pos,
                        "generations": pattern,
                        "size": len(pattern),
                        "metrics": metrics,
                        "is_rightmost": is_rightmost,
                    }
    
    # 2-cell seeds (adjacent)
    print("Trying adjacent 2-cell seeds...")
    for pos in range(max_width - 1):
        seed = (1 << pos) | (1 << (pos + 1))
        pattern = generate_pattern(seed, max_width, max_gens)
        
        if pattern:
            cells_history = [int_to_cells(g, max_width) for g in pattern]
            metrics = analyze_pattern_metrics(cells_history)
            
            if metrics:
                pattern_tuple = tuple(pattern)
                if pattern_tuple not in pattern_set:
                    pattern_set.add(pattern_tuple)
                    patterns[f"adjacent_{pos}"] = {
                        "seed": hex(seed),
                        "seed_position": pos,
                        "generations": pattern,
                        "size": len(pattern),
                        "metrics": metrics,
                        "is_rightmost": False,
                    }
    
    # 2-cell seeds (gap of 1)
    print("Trying separated 2-cell seeds...")
    for pos in range(max_width - 2):
        seed = (1 << pos) | (1 << (pos + 2))
        pattern = generate_pattern(seed, max_width, max_gens)
        
        if pattern:
            cells_history = [int_to_cells(g, max_width) for g in pattern]
            metrics = analyze_pattern_metrics(cells_history)
            
            if metrics:
                pattern_tuple = tuple(pattern)
                if pattern_tuple not in pattern_set:
                    pattern_set.add(pattern_tuple)
                    patterns[f"separated_{pos}"] = {
                        "seed": hex(seed),
                        "seed_position": pos,
                        "generations": pattern,
                        "size": len(pattern),
                        "metrics": metrics,
                        "is_rightmost": False,
                    }
    
    print(f"\nFound {len(patterns)} unique triangle patterns")
    
    # Rank by bounding box growth (best triangles)
    ranked = sorted(
        patterns.items(),
        key=lambda x: x[1].get('metrics', {}).get('width_growth', 0),
        reverse=True
    )
    
    print("\n" + "="*60)
    print("TOP 5 TRIANGLE PATTERNS (by bounding box growth)")
    print("="*60)
    for i, (key, pattern) in enumerate(ranked[:5]):
        metrics = pattern.get('metrics', {})
        print(f"\n{i+1}. {key}")
        print(f"   Seed position: {pattern.get('seed_position', '?')}")
        print(f"   Width growth: {metrics.get('initial_width', 0)} → {metrics.get('final_width', 0)} (Δ{metrics.get('width_growth', 0)})")
        print(f"   Max width reached: {metrics.get('max_width', 0)}")
        print(f"   Persistence: {metrics.get('persistence', 0)} generations")
        print(f"   Is rightmost: {pattern.get('is_rightmost', False)}")
    
    # Visualize best pattern
    if ranked:
        print("\n" + "="*60)
        print("BEST PATTERN VISUALIZATION")
        print("="*60)
        best_key, best_pattern = ranked[0]
        gens = [int_to_cells(g, 64) for g in best_pattern['generations']]
        visualize_pattern(gens[:15], best_key)  # Show first 15 generations
    
    return patterns

def visualize_pattern(generations: List[List[int]], name: str):
    """Print a pattern as ASCII art."""
    print(f"\nPattern: {name}")
    for i, gen in enumerate(generations):
        line = ''.join(['█' if cell else '·' for cell in gen])
        print(f"  gen {i:2d}: {line}")

def main():
    # Generate patterns
    patterns = generate_all_patterns(max_width=64, max_gens=20)
    
    # Stats
    print(f"\nPattern Statistics:")
    print(f"  Total unique patterns: {len(patterns)}")
    
    sizes = [p['size'] for p in patterns.values()]
    if sizes:
        print(f"  Generation depth range: {min(sizes)} - {max(sizes)}")
    
    widths = [p.get('metrics', {}).get('final_width', 0) for p in patterns.values() if p.get('metrics')]
    if widths:
        print(f"  Final width range: {min(widths)} - {max(widths)}")
    
    # Save to JSON
    output = {
        "metadata": {
            "rule": "Rule 110",
            "max_width": 64,
            "max_generations": 20,
            "pattern_count": len(patterns)
        },
        "patterns": patterns
    }
    
    with open('triangle_patterns.json', 'w') as f:
        json.dump(output, f, indent=2)
    
    print(f"\nSaved to triangle_patterns.json")
    
    # Show a sample pattern
    if patterns:
        sample_key = list(patterns.keys())[0]
        sample = patterns[sample_key]
        print(f"\nSample pattern: {sample_key}")
        print(f"  Seed: {sample['seed']}")
        print(f"  Generations: {sample['size']}")
        metrics = sample.get('metrics', {})
        print(f"  Final width: {metrics.get('final_width', 'N/A')}")
        print(f"  Pattern (hex): {[hex(g) for g in sample['generations'][:5]]}...")

if __name__ == '__main__':
    main()
