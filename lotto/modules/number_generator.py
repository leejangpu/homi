"""로또 번호 생성 모듈."""

import random


def generate_lotto_numbers() -> list[int]:
    """1~45 중 중복 없이 6개의 번호를 생성하여 오름차순 반환."""
    numbers = random.sample(range(1, 46), 6)
    numbers.sort()
    return numbers
